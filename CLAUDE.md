# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

**Spørge Jørgen** is an Electron-based desktop support application that enables non-technical customer support staff to query databases and explore
codebases using natural language. The app acts as an intelligent assistant (Jørgen) that translates user questions into database queries and code
searches, then simplifies technical results into business-friendly language.

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
- Electron main process auto-reloads via nodemon
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
│ - ClaudeService: Anthropic API orchestration            │
│ - DatabaseService: Multi-layer read-only enforcement    │
│ - GitHubService: Repository code exploration            │
│ - VectorStoreService: Semantic knowledge retrieval      │
│ - ChatService: Persistent conversation storage          │
│ - SettingsService: User preferences                     │
└─────────────────────────────────────────────────────────┘
```

### Service Responsibilities

**ClaudeService** (`electron/services/claude-service.ts`)

- Orchestrates all Claude API interactions
- Manages extended thinking mode (2000 token budget)
- Implements two-stage response flow:
    1. **Technical stage:** Claude uses tools (database queries, GitHub searches) with full context
    2. **Simplification stage:** Converts technical response to business-friendly language
- Handles CSV export tool for data extraction requests
- Integrates vector store context into system prompts

**DatabaseService** (`electron/services/database-service.ts`)

- **CRITICAL:** Enforces READ-ONLY database access at 5 layers:
    1. Query whitelist (SELECT, SHOW, DESCRIBE, EXPLAIN only)
    2. Keyword blacklist (blocks INSERT, UPDATE, DELETE, etc.)
    3. Multiple statement protection (semicolon detection)
    4. MySQL session read-only mode (`SET SESSION TRANSACTION READ ONLY`)
    5. Read-only transaction enforcement
- Logs all queries with timestamps to `query-log.txt`
- Connection pooling with unique keys per database
- Supports dynamic database selection (not hardcoded in config)

**VectorStoreService** (`electron/services/vector-store-service.ts`)

- Pre-built vector store loaded from `assets/vector/vector.store`
- Uses Claude Haiku 3.5 for semantic document retrieval
- Context-aware search: combines recent conversation history with current query
- Returns top 3 most relevant knowledge documents
- Documents are injected into Claude's system prompt

**GitHubService** (`electron/services/github-service.ts`)

- GitHub API integration for code exploration tools
- Supports both classic tokens (`ghp_*`) and fine-grained tokens (`github_pat_*`)
- Provides tools to Claude:
    - `search_code`: GitHub code search
    - `read_file`: Fetch file contents from repository
    - `list_files`: List directory contents
    - `get_repository_structure`: Full recursive tree

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

### CSV Export Intelligence

When users ask for "list", "liste", "udtræk", "export", "oversigt" - the app automatically:

1. Detects export keywords in user message
2. Tracks query results from Claude's database queries
3. Auto-exports largest result (≥10 rows) to Downloads folder
4. Injects CSV creation info into conversation
5. Claude mentions the file in final answer

Files are saved as: `export_YYYY-MM-DD_HH-MM-SS.csv`

### Multi-Language Support

- Detects user's language automatically
- System prompts enforce: "ALWAYS respond in the same language as the user's question"
- Bilingual system knowledge (English/Danish)
- Simplification stage preserves original language

### Debug Window

Separate Electron window (`#debug` route) that displays:

- Database queries with full SQL
- Tool usage (GitHub searches, file reads)
- Claude API calls and thinking blocks
- Vector store search results
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
  components/
    ChatView.tsx       # Chat interface with message history
    SettingsView.tsx   # Configuration UI
    DebugView.tsx      # Developer logging window
    ConfirmModal.tsx   # Reusable confirmation dialog

assets/
  vector/
    vector.store       # Pre-built semantic knowledge base
    system-knowledge.json  # Source documents for vector store

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
- `settings.json` - User name, auto-TL;DR preference
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

ClaudeService implements agentic tool use:

1. Send message with tools available
2. If `stop_reason === 'tool_use'`: execute tools, return results, repeat
3. Max 10 iterations to prevent infinite loops
4. Progress callbacks update UI during each tool use

### Read-Only Enforcement

DatabaseService security cannot be bypassed:

- Application-level checks (whitelist/blacklist)
- Database-level enforcement (`SET SESSION TRANSACTION READ ONLY`)
- Query logging for audit trail
- Any write attempt logs "SECURITY VIOLATION" and throws

## Asset Copying

The `copy:assets` script copies `assets/` to `dist/assets/` during build. Vector store must be in `dist/assets/vector/vector.store` at runtime.

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

- Edit system prompt in `ClaudeService.sendMessage()` (line ~348)
- Adjust thinking budget in API calls (currently 2000 tokens)
- Modify simplification prompt (line ~814)

**Add vector store knowledge:**

1. Edit `assets/vector/system-knowledge.json`
2. Rebuild vector store (currently manual process with Claude API)
3. Copy to `assets/vector/vector.store`
4. Rebuild app to include in `dist/assets/`

**Extend tool capabilities:**
Add new tools to the `tools` array in `ClaudeService.sendMessage()`, then implement handlers in the tool use loop (line ~496).
