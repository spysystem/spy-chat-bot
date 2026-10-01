# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

**Spørge Jørgen** is an Electron-based desktop support application that enables non-technical customer support staff to query databases and explore
codebases using natural language. The app acts as an intelligent assistant (Jørgen) that translates user questions into database queries and code
searches, and answers in business-friendly language.

**Product Name:** Spørge Jørgen ("Ask George" in Danish)
**App ID:** com.spy.support-claude
**Target Users:** Customer support staff without programming knowledge

## Build & Development Commands

```bash
# Development mode (runs both Vite and Electron with hot reload)
npm run dev

# Build for production
npm run build                  # Build both electron and renderer
npm run build:electron         # Build only Electron main process
npm run build:vite             # Build only Vite renderer

# Package for distribution
npm run package                # Auto-detect platform
npm run package:win            # Windows (NSIS installer)
npm run package:mac            # macOS (DMG, x64 + arm64)
npm run package:linux          # Linux (AppImage)
```

**Development workflow:**

- Frontend runs on `http://localhost:5173` (Vite dev server)
- Main-process changes need a restart of `npm run dev` (no auto-reload)
- TypeScript compilation happens automatically

## Architecture Overview

### Three-Layer Architecture

```
┌─────────────────────────────────────────────────────────┐
│ Frontend (React 19 + TypeScript)                        │
│ - ChatView: Main chat interface                         │
│ - SettingsView: Configure databases, GitHub, API keys   │
│ - DebugView: Developer logging window                   │
└────────────────┬────────────────────────────────────────┘
                 │ IPC (Inter-Process Communication)
┌────────────────▼────────────────────────────────────────┐
│ Electron Main Process                                   │
│ - IPC handlers route requests to services               │
│ - Single service instances shared across app            │
└────────────────┬────────────────────────────────────────┘
                 │
┌────────────────▼────────────────────────────────────────┐
│ Services Layer (electron/services/)                     │
│ - ClaudeService: Claude agent loop (Opus 5.5)           │
│ - claude-tools: tool definitions for the agent          │
│ - DatabaseService: Multi-layer read-only enforcement    │
│ - GitHubService + LocalRepoService: code access / sync  │
│ - KnowledgeService: BM25 search over example SQL        │
│ - ChatService: Persistent conversation storage          │
│ - SettingsService: User preferences                     │
└─────────────────────────────────────────────────────────┘
```

### Service Responsibilities

**ClaudeService** (`electron/services/claude-service.ts`)

- Uses the official `@anthropic-ai/sdk` directly (no TanStack/OpenAI layer). Model `claude-opus-5-5` (`MAIN_MODEL`); title and working-summary calls use `claude-haiku-4-5`
- One streaming agent loop (`client.beta.messages.stream`): adaptive thinking (`display: "summarized"`), `output_config.effort` from the quality setting (Balanced = `medium`, Maximum Accuracy = `high`), prompt caching (static system block + automatic top-level cache), server-side refusal fallback (`fallbacks: "default"`, beta `server-side-fallback-2026-07-01`)
- Up to 40 model turns; tool calls in a turn run in parallel; the last turn uses `tool_choice: none` so the model must answer
- The model writes the user-facing answer itself - there is no separate "simplification" pass. `detailedAnswer` = answer + an "Investigation details" appendix (SQL run, files read, searches) built from the tool evidence log
- System prompt = `STATIC_SYSTEM_PROMPT` (cached) + a per-request block (connected database, branch, available sources, working summary). The full prompt is logged to the Debug window as "Claude system prompt" on every question
- After each answer a working summary is written in the background (Haiku) and stored on the chat; the next turn waits for it
- Emits AG-UI-style events to the renderer (`TEXT_MESSAGE_START/CONTENT/END` with a per-turn `messageId`, `TOOL_CALL_START/END`, `STEP_STARTED/FINISHED` for thinking, `RUN_STARTED/FINISHED`). The renderer replaces the streamed text when a new turn starts, so pre-tool progress notes are not kept

**Agent tools** (`electron/services/claude-tools.ts`) - only registered when the source is configured:

- Database: `search_schema`, `describe_table` (schema index per connection + release branch, falls back to live `DESCRIBE`; `refreshSchemaIndex()` in `main.ts` builds it in the background from the chat's own database/host when missing or older than a day), `query_database` (≤200 rows as TSV; errors come back with schema suggestions), `export_to_csv` (full result to Downloads, UTF-8 BOM)
- Code (local clone): `search_code` (ripgrep; literal by default, optional regex/path/glob/context), `read_file` (line ranges, 1500 lines per call), `list_directory`, `find_files`. Without a local clone, GitHub API fallbacks for `search_code`/`read_file`/`list_directory`
- Code history (local clone): `file_history` (commits touching a path, optional pickaxe `search`, each annotated with the first `YYYY_MM` release branch containing it), `show_commit`, `compare_branches` (e.g. `2026_07..2026_09`)
- Sentry (when a token is set in Settings): `search_errors` (issues + counts for the chat's system via the `system_key` tag, Discover events API) and `get_error_details` (latest event's stack trace, request, breadcrumbs; server paths trimmed to repo paths)
- `spy_search_code` / `spy_search_context` when the spy-code-ai MCP server is configured (Cursor MCP config)
- `search_knowledge` (always; example SQL queries) and `ask_clarifying_question` (ends the run and shows the question with clickable options)
- `web_search` / `web_fetch` (always): Anthropic's server-side tools (`web_search_20260209`, `web_fetch_20260209`), declared in `WEB_TOOLS` in `claude-service.ts`. They run on Anthropic's servers inside the model turn (max 5 searches and 5 fetches per request), so the loop never executes them. The system prompt limits them to questions about things outside SPY (carriers, platforms, EDI, VAT, external error messages) and forbids customer data in search queries. Searches and the pages used go into "Investigation details". Web search must be enabled for the organisation in the Claude Console

**DatabaseService** (`electron/services/database-service.ts`)

- **CRITICAL:** Enforces READ-ONLY database access at 5 layers:
    1. Query whitelist (SELECT, SHOW, DESCRIBE, EXPLAIN only)
    2. Keyword blacklist (blocks INSERT, UPDATE, DELETE, etc.; the `REPLACE(...)` string function is allowed)
    3. Multiple statement protection (semicolon detection)
    4. MySQL session read-only mode (`SET SESSION TRANSACTION READ ONLY`)
    5. Every query runs in its own `START TRANSACTION READ ONLY` ... `ROLLBACK` (fresh snapshot per query)
- Logs all queries with timestamps to `query-log.txt`
- One `mysql2` pool per config/host/database (dead connections are replaced automatically)
- Supports dynamic database selection (not hardcoded in config)

**SentryService** (`electron/services/sentry-service.ts`)

- Token/org/API URL stored encrypted (`secure/sentry-config.encrypted`); the token is never sent to the renderer. Defaults: org `spy-aps`, `https://us.sentry.io`
- Customer systems tag events with `system_key`, which equals the system directory's `systemKey` stored on the chat

**KnowledgeService** (`electron/services/knowledge-service.ts`)

- Loads `assets/knowledge/sql-examples.jsonl`: ~80 example SQL queries for common data questions (orders, styles/colors/sizes, customers, consignment, newsletters, mail log), each checked with `EXPLAIN` against a live database
- BM25 keyword ranking; only used through the `search_knowledge` tool (nothing is put in the system prompt automatically)
- Table synonyms and "where data lives" are in `STATIC_SYSTEM_PROMPT` instead

**GitHubService** (`electron/services/github-service.ts`) and **LocalRepoService** (`electron/services/local-repo-service.ts`)

- GitHubService holds the encrypted GitHub config (token/owner/repo), validates it, and offers REST API fallbacks
- LocalRepoService owns Local Git Sync under `userData/repos/`: a partial clone (`--filter=blob:none --no-checkout`) in `spy/`, one **detached** worktree per branch in `spy-worktrees/`, and state in `spy-state.json`
- The token is sent as an `http.extraheader` through `GIT_CONFIG_*` environment variables - it is never written to `.git/config` or command lines. Works with classic and fine-grained PATs
- All git mutations are serialised by one lock (the model calls tools in parallel). Branches are fetched when older than 5 minutes; a worktree is moved to its branch's latest commit whenever it is used; "Sync Repository" and the 20-minute background job fetch and refresh every worktree, remove worktrees for deleted branches, and prune ones unused for 21 days
- Clones go to a temp dir and are renamed on success; a broken clone or a changed repository URL triggers a fresh clone
- A chat without a branch uses the repository's default branch (`origin/HEAD`), not the unused `branch` field in the GitHub config
- Every fetch also runs `git remote set-head origin --auto`, because fetch leaves `origin/HEAD` pointing at a deleted branch when GitHub's default branch changes
- Before each question `resolveChatBranch()` in `main.ts` moves a chat to its system's current release (system directory lookup, `resolveSystemBranch()` in `electron/services/shared/release-branch.ts`, shared with the renderer) and uses the default branch if the chat's branch no longer exists

### Deep Link Protocol

The app registers the `sporge-jorgen://` protocol for external integrations:

```
sporge-jorgen://open?database=spy_live&branch=2026_02
```

**Behavior:**

1. Creates new chat with database pre-selected
2. Updates GitHub branch if `branch` parameter provided
3. Focuses main window
4. Handled on both first launch and when app is already running

## Database Context: SPY System

The app is designed to query the **SPY System** - a comprehensive warehouse management and e-commerce platform:

- **Backend:** PHP 8.1 with 100+ spysystem packages
- **Frontend:** React 19 with TypeScript
- **Naming conventions:** Hungarian notation (`iID`, `strName`, `bActive`, `fPrice`)
- **Architecture:** Entity-based ORM with EntityWrapper base class
- **Key rule:** No NULL values - use 0 for unset integers, empty string for text
- **All tables have:** audit fields (added_user_id, added_date, changed_user_id, changed_date)

**System handles:**

- Order processing and fulfillment
- Multi-warehouse inventory
- Shipping integrations (DHL, UPS, FedEx, GLS, PostNord, Bring)
- E-commerce platforms (Shopify, WooCommerce, Sitoo)
- B2B operations
- EDI communication (ORDERS, DESADV, INVOIC)

**Important query rules embedded in system prompt:**

- Never query from `bi_*` views (use actual tables instead)
- Always check table structure before querying
- Use LIMIT for large tables
- Explicit joins required

## Key Behavioral Features

### Auto-Update Modal

The app features a prominent update modal that appears automatically when new versions are available:

**Behavior:**

- 3 seconds after app start, checks GitHub releases for updates
- If update found, modal appears automatically (cannot be missed)
- Shows version number, download progress in real-time
- User workflow: "Download Update" → Shows progress bar → "Restart and Install"
- Modal can be dismissed unless `forceUpdate` flag is set to `true`

**Force Update Mode:**
To require users to update (cannot dismiss modal):

1. Edit `src/App.tsx`
2. Find line: `const [forceUpdate, setForceUpdate] = useState(false)`
3. Change to: `const [forceUpdate, setForceUpdate] = useState(true)`
4. Users must download and install update to continue

**Components:**

- `UpdateModal.tsx` - Modal component with download/install UI
- `App.tsx` - Integrates modal with auto-update events
- `electron/main.ts:23` - `autoUpdater.autoDownload = true` for automatic downloads

### CSV Export

When users ask for a list/export/extract ("liste", "udtræk", "oversigt", "export"), the system prompt tells the model to call `export_to_csv`. Files are saved to the Downloads folder as `<descriptive_name>_YYYY-MM-DD_HH-MM-SS.csv` and the model names the file in its answer.

### Record Links and Charts in Answers

- The static system prompt lists URL templates for SPY record pages (sales order `/go/sales-order/{id}`, customer, style, claim, delivery, purchase order, supplier, user, ...); the per-chat block gives the base URL from the chat's `systemUrl`. Links open in the user's browser - `routeLinksToBrowser()` in `main.ts` stops the app window from navigating away
- The model can emit a ` ```chart ` fenced block with JSON (`{"type": "bar"|"line", "title", "unit", "x": [...], "series": [{"name", "values"}]}`); `MarkdownPre` in `src/components/ChartBlock.tsx` renders it as an SVG chart (max 4 series, legend, hover tooltip, table toggle, light/dark palette in `ChartBlock.css`)

### Multi-Language Support

- The system prompt tells the model to answer in the user's language while keeping SPY's English UI terms (consignment, style, assortment, ...) untranslated
- The app UI is Danish by default with English as an option (Settings → Profile → Language, stored in `localStorage`). All UI text lives in `src/i18n.tsx` (`useI18n().t(key)`); the Danish dictionary is typed against the English one, so a missing translation fails the typecheck. Progress statuses are sent in English by the main process and translated by pattern in `translateProgress()` - update `DANISH_PROGRESS` when adding a new `onProgress` text

### Debug Window

Separate Electron window (`#debug` route) that displays:

- Database queries with full SQL
- Tool usage (GitHub searches, file reads)
- Claude API calls and thinking blocks
- The full system prompt for each question
- Error stack traces

Access via Settings → Open Debug Window

### Secure Storage (Encrypted Credentials)

**ALL** sensitive data is encrypted using Electron's `safeStorage` API with OS-native encryption:

- **Windows:** DPAPI (Data Protection API) - tied to Windows user account
- **macOS:** Keychain
- **Linux:** Secret Service API (libsecret)

**Encrypted Data:**

- Claude API key → `secure/claude-api-key.encrypted`
- GitHub full config → `secure/github-config.encrypted` (token, owner, repo, branch)
- Database full configs → `secure/db-config-{id}.encrypted` (name, host, port, database, username, password)

**Plain Text Config Files (placeholders only):**

- `github-config.json` - empty placeholder (all data encrypted)
- `database-configs.json` - only IDs (all data encrypted)
- `chats.json` - conversation history (not sensitive)
- `settings.json` - user preferences (not sensitive)

**Security Notes:**

- All connection details and credentials fully encrypted at rest
- Encrypted files are tied to OS user login
- Cannot be copied to another computer
- Lost Windows/macOS password = lost credentials
- Protects against: stolen laptop, disk theft, file system access
- Even database hostnames and GitHub repo names are encrypted

## File Structure

```
electron/
  main.ts              # Electron entry, IPC handlers, auto-updater
  preload.ts           # IPC bridge (context isolation)
  types.ts             # Shared TypeScript interfaces
  services/            # Service layer (see above)

src/
  App.tsx              # Main app with sidebar, navigation, deep link handler
  ThemeContext.tsx     # Dark/light theme provider
  ai/
    AiStreamContext.tsx  # Stream state per chat, clarification flow
  components/
    ChatView.tsx       # Chat interface with message history
    SettingsView.tsx   # Configuration UI
    DebugView.tsx      # Developer logging window
    ConfirmModal.tsx   # Reusable confirmation dialog
    Icon.tsx           # Inline SVG icon set (use instead of emoji)
    SettingsSection.tsx # Card wrapper + status text shared by settings sections

assets/
  prompts/
    spy-code-ai-chatbot.mdc  # Extra system prompt when the spy-code-ai MCP is configured
  knowledge/
    sql-examples.jsonl # Example SQL queries (JSONL), searched with BM25 by search_knowledge

dist/
  electron/            # Compiled main process (TypeScript → CommonJS)
  renderer/            # Compiled React app (Vite build)
  assets/              # Copied from assets/ during build

release/               # Packaged installers (electron-builder output)
```

## Configuration Files

All user configuration stored in Electron's userData directory:

- `claude-api-key.txt` - Anthropic API key
- `database-configs.json` - Array of database connection configs
- `github-config.json` - GitHub token, owner, repo, branch
- `chats.json` - Persistent chat history
- `user-settings.json` - User name, local repo URL, answer quality profile
- `repos/` - Local Git Sync clone, worktrees and `spy-state.json`
- `query-log.txt` - All executed queries with timestamps

## TypeScript Configuration

- **Main process:** `tsconfig.electron.json` → compiles to CommonJS in `dist/electron/`
- **Renderer:** `tsconfig.json` → handled by Vite, outputs to `dist/renderer/`
- Root dir separation prevents cross-contamination

## Auto-Updater

Uses `electron-updater` with manual download approval:

- Checks for updates 3 seconds after app launch (production only)
- User prompted to download when available
- Auto-installs on quit after download
- IPC handlers: `check-for-updates`, `download-update`, `install-update`

## Important Patterns

### IPC Communication

All Electron APIs exposed via preload script:

```typescript
// Renderer calls (from React)
await window.electronAPI.sendMessage(message, databases, history, databaseName)

// Main process handles (electron/main.ts)
ipcMain.handle('send-message', async (event, message, databases, history, databaseName) => {
	return await claudeService.sendMessage(...)
})
```

### Tool Use Loop

`ClaudeService.sendMessage()` runs the loop itself (no SDK tool runner):

1. Stream a request with all tools; forward text/thinking/tool events to the renderer
2. If `stop_reason === 'tool_use'`: run every tool call of the turn in parallel, send all results in one user message, repeat
3. At most 40 turns; the final turn forces `tool_choice: none`
4. `refusal` (after server-side fallback) and `pause_turn` are handled explicitly

### Read-Only Enforcement

DatabaseService security cannot be bypassed:

- Application-level checks (whitelist/blacklist)
- Database-level enforcement (`SET SESSION TRANSACTION READ ONLY`)
- Query logging for audit trail
- Any write attempt logs "SECURITY VIOLATION" and throws

## Asset Copying

The `copy:assets` script replaces `dist/assets/` with a copy of `assets/` during build. The examples must be in `dist/assets/knowledge/sql-examples.jsonl` at runtime.

## Testing Database Connections

Use the Settings view to:

1. Add database config (host, port, username, password)
2. Click "Test Connection" to verify
3. Select database(s) for chat context
4. Database names can be specified dynamically per chat (deep link support)

## Common Development Tasks

**Add a new service:**

1. Create in `electron/services/`
2. Instantiate in `electron/main.ts`
3. Add IPC handlers in main.ts
4. Add method signatures to `window.electronAPI` in `src/types.ts`
5. Add preload bindings in `electron/preload.ts`

**Modify Claude's behavior:**

- Edit `STATIC_SYSTEM_PROMPT` (bottom of `claude-service.ts`) for behaviour that applies to every chat; per-request context is built in `buildSystemPrompt()`
- Model, effort mapping, turn limit and token limits are constants at the top of `claude-service.ts`

**Add an example query:**

1. Add a JSONL line (`{"id": "sql-NNN", "content": "Example: <question>\n<SQL>"}`) to `assets/knowledge/sql-examples.jsonl`, after checking the SQL with `EXPLAIN` on a live system
2. Rebuild the app to include it in `dist/assets/`

**Extend tool capabilities:**
Add a tool with the `tool(...)` helper in `createAgentTools()` (`claude-tools.ts`). Tools return `{content, isError?}`; push an `EvidenceItem` if the lookup should show up under "Details".
