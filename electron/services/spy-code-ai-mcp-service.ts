import {app} from 'electron';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';

interface CursorMcpServerConfig {
	url?: string;
	headers?: Record<string, string>;
}

interface CursorMcpConfigFile {
	mcpServers?: Record<string, CursorMcpServerConfig>;

	[key: string]: unknown;
}

export interface SpySearchCodeArgs {
	query: string;
	kind?: 'entity_field' | 'class' | 'method' | 'sql_query' | 'route' | 'relation' | 'ts_file' | 'view' | 'api_endpoint';
	limit?: number;
	match_mode?: 'auto' | 'semantic' | 'symbolic' | 'hybrid';
}

export interface SpySearchContextArgs {
	query: string;
	limit?: number;
}

type McpClientInstance = {
	connect: (transport: unknown) => Promise<void>;
	listTools: () => Promise<{ tools?: Array<{ name?: string }> }>;
	callTool: (params: { name: string; arguments?: Record<string, unknown> }) => Promise<any>;
	close?: () => Promise<void>;
};

type McpTransportInstance = {
	close?: () => Promise<void>;
};

type ResolvedSpyConfig = {
	url: string;
	headers: Record<string, string>;
};

const MCP_SERVER_NAME    = 'spy-code-ai';
const DEFAULT_TIMEOUT_MS = 15_000;

export class SpyCodeAiMcpService {
	private configCache: ResolvedSpyConfig | null | undefined;
	private client: McpClientInstance | null                  = null;
	private transport: McpTransportInstance | null            = null;
	private toolNames: Set<string> | null                     = null;
	private connectionKey: string | null                      = null;
	private connectPromise: Promise<McpClientInstance> | null = null;

	async isConfigured(): Promise<boolean> {
		return !!(await this.getConfig());
	}

	async searchCode(args: SpySearchCodeArgs): Promise<unknown> {
		return await this.callTool('search_code', {...args});
	}

	async searchContext(args: SpySearchContextArgs): Promise<unknown> {
		return await this.callTool('search_context', {...args});
	}

	private async callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
		const client = await this.ensureClient();
		if (this.toolNames && !this.toolNames.has(name)) {
			throw new Error(`spy-code-ai MCP is connected, but tool "${name}" is not exposed by the server.`);
		}

		const result = await this.withTimeout(
			client.callTool({
				name,
				arguments: args,
			}),
			`${name} timed out after ${DEFAULT_TIMEOUT_MS / 1000}s`,
		);

		if (result?.isError) {
			throw new Error(this.extractTextContent(result) || `spy-code-ai MCP returned an error for tool "${name}".`);
		}

		return this.normalizeToolResult(result);
	}

	private async ensureClient(): Promise<McpClientInstance> {
		const config = await this.getConfig();
		if (!config) {
			throw new Error(`spy-code-ai MCP is not configured in ${this.getConfigPath()}.`);
		}

		const key = JSON.stringify(config);
		if (this.client && this.connectionKey === key) {
			return this.client;
		}
		if (this.connectPromise && this.connectionKey === key) {
			return await this.connectPromise;
		}

		this.connectionKey  = key;
		this.connectPromise = this.connectWithFallback(config);
		try {
			this.client = await this.connectPromise;
			return this.client;
		} finally {
			this.connectPromise = null;
		}
	}

	private async connectWithFallback(config: ResolvedSpyConfig): Promise<McpClientInstance> {
		await this.closeConnection();

		const [{Client}, {StreamableHTTPClientTransport}, {SSEClientTransport}] = await Promise.all([
			import('@modelcontextprotocol/sdk/client'),
			import('@modelcontextprotocol/sdk/client/streamableHttp.js'),
			import('@modelcontextprotocol/sdk/client/sse.js'),
		]);

		const requestInit: RequestInit = {
			headers: config.headers,
		};
		const url                      = new URL(config.url);

		const createClient = (): McpClientInstance => new Client(
			{
				name   : 'spy-chat-bot',
				version: app.getVersion(),
			},
			{
				capabilities: {},
			},
		) as McpClientInstance;

		const connectAndList = async (transport: McpTransportInstance): Promise<McpClientInstance> => {
			const client = createClient();
			await this.withTimeout(client.connect(transport), 'spy-code-ai MCP connection timed out.');
			const listedTools = await this.withTimeout(client.listTools(), 'spy-code-ai MCP tool discovery timed out.');
			this.transport    = transport;
			this.toolNames    = new Set((listedTools.tools || []).map((tool) => String(tool.name || '')).filter(Boolean));
			return client;
		};

		try {
			return await connectAndList(new StreamableHTTPClientTransport(url, {requestInit}) as McpTransportInstance);
		} catch (streamableError) {
			try {
				return await connectAndList(new SSEClientTransport(url, {requestInit}) as McpTransportInstance);
			} catch (sseError) {
				const primary  = streamableError instanceof Error ? streamableError.message : String(streamableError);
				const fallback = sseError instanceof Error ? sseError.message : String(sseError);
				throw new Error(`Failed to connect to spy-code-ai MCP. Streamable HTTP error: ${primary}. SSE fallback error: ${fallback}.`);
			}
		}
	}

	private async closeConnection(): Promise<void> {
		if (this.client?.close) {
			try {
				await this.client.close();
			} catch {
				// Best effort cleanup only.
			}
		}
		if (this.transport?.close) {
			try {
				await this.transport.close();
			} catch {
				// Best effort cleanup only.
			}
		}
		this.client    = null;
		this.transport = null;
		this.toolNames = null;
	}

	private async getConfig(): Promise<ResolvedSpyConfig | null> {
		if (this.configCache !== undefined) {
			return this.configCache;
		}

		try {
			const raw       = await fs.readFile(this.getConfigPath(), 'utf-8');
			const parsed    = JSON.parse(raw) as CursorMcpConfigFile;
			const direct    = this.asServerConfig(parsed[MCP_SERVER_NAME]);
			const nested    = this.asServerConfig(parsed.mcpServers?.[MCP_SERVER_NAME]);
			const candidate = direct || nested;
			if (!candidate?.url) {
				this.configCache = null;
				return this.configCache;
			}

			this.configCache = {
				url    : candidate.url,
				headers: this.normalizeHeaders(candidate.headers),
			};
			return this.configCache;
		} catch {
			this.configCache = null;
			return this.configCache;
		}
	}

	private asServerConfig(value: unknown): CursorMcpServerConfig | null {
		if (!value || typeof value !== 'object') {
			return null;
		}
		return value as CursorMcpServerConfig;
	}

	private normalizeHeaders(value: unknown): Record<string, string> {
		if (!value || typeof value !== 'object') {
			return {};
		}
		return Object.fromEntries(
			Object.entries(value as Record<string, unknown>)
				.filter(([key, headerValue]) => key.trim() !== '' && typeof headerValue === 'string' && headerValue.trim() !== '')
				.map(([key, headerValue]) => [key, String(headerValue)]),
		);
	}

	private getConfigPath(): string {
		return path.join(os.homedir(), '.cursor', 'mcp.json');
	}

	private extractTextContent(result: any): string {
		const parts = Array.isArray(result?.content) ? result.content : [];
		return parts
			.filter((part: any) => part?.type === 'text' && typeof part.text === 'string')
			.map((part: any) => String(part.text))
			.join('\n')
			.trim();
	}

	private normalizeToolResult(result: any): unknown {
		if (result && typeof result === 'object' && 'structuredContent' in result && result.structuredContent !== undefined) {
			return result.structuredContent;
		}
		if (result && typeof result === 'object' && 'toolResult' in result && result.toolResult !== undefined) {
			return result.toolResult;
		}

		const textContent = this.extractTextContent(result);
		if (textContent) {
			try {
				return JSON.parse(textContent);
			} catch {
				return textContent;
			}
		}

		return result;
	}

	private async withTimeout<T>(promise: Promise<T>, timeoutMessage: string): Promise<T> {
		let timeoutHandle: NodeJS.Timeout | null = null;
		try {
			return await Promise.race([
				promise,
				new Promise<T>((_, reject) => {
					timeoutHandle = setTimeout(() => reject(new Error(timeoutMessage)), DEFAULT_TIMEOUT_MS);
				}),
			]);
		} finally {
			if (timeoutHandle) {
				clearTimeout(timeoutHandle);
			}
		}
	}
}
