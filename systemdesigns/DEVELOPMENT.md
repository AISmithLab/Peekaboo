# Development Guide

How the codebase is structured and how to modify it.

## Project Structure

```
PersonalDataHub/
├── src/
│   ├── index.ts                 # Entry point — loads config, creates DB, starts server
│   ├── cli.ts                   # CLI commands (init, start, stop, status, mcp, reset)
│   ├── config/                  # Configuration system
│   │   ├── types.ts             # TypeScript interfaces (HubConfig, SourceConfig, etc.)
│   │   ├── schema.ts            # Zod schemas for config validation
│   │   └── loader.ts            # YAML loading with ${ENV_VAR} resolution
│   ├── db/                      # Database layer
│   │   ├── db.ts                # SQLite connection (WAL mode, foreign keys)
│   │   ├── schema.ts            # CREATE TABLE statements
│   │   └── encryption.ts        # AES-256-GCM encrypt/decrypt for OAuth tokens
│   ├── auth/                    # Authentication
│   │   ├── oauth-routes.ts      # OAuth flows (Gmail, GitHub)
│   │   └── token-manager.ts     # Encrypted token storage and refresh
│   ├── connectors/              # Source service integrations
│   │   ├── types.ts             # DataRow interface, SourceConnector interface
│   │   ├── gmail/
│   │   │   └── connector.ts     # Gmail fetch, executeAction
│   │   └── github/
│   │       ├── connector.ts     # GitHub access validation, fetch issues/PRs
│   │       └── setup.ts         # Grant/revoke collaborator access
│   ├── filters.ts               # Quick filter types, catalog, and apply logic
│   ├── mcp/                     # MCP server
│   │   ├── server.ts            # Stdio MCP server with source-specific tools
│   │   └── server.test.ts       # MCP server tests
│   ├── audit/
│   │   └── log.ts               # AuditLog class — typed write methods + filtered queries
│   ├── server/                  # HTTP layer
│   │   ├── server.ts            # Hono app setup, mounts API + GUI + OAuth routes
│   │   └── app-api.ts           # POST /pull, POST /propose, GET /sources
│   ├── gui/
│   │   └── routes.ts            # Self-contained HTML GUI with inline JS
│   └── test-utils.ts            # Shared test utilities
├── packages/
│   └── personaldatahub/         # OpenClaw skill
│       └── src/
│           ├── index.ts         # Plugin registration
│           ├── hub-client.ts    # HTTP client for PersonalDataHub API
│           ├── tools.ts         # Tool definitions
│           └── prompts.ts       # System prompt for teaching agents
├── tests/
│   └── e2e/                     # End-to-end integration tests
│       ├── helpers.ts           # Shared setup (mock connector, in-memory DB)
│       ├── gmail-recent-readonly.test.ts
│       ├── gmail-metadata-only.test.ts
│       ├── gmail-full-access-redacted.test.ts
│       └── gmail-staged-action.test.ts
├── systemdesigns/                        # Documentation
├── hub-config.example.yaml
├── package.json
├── tsconfig.json
├── vitest.config.ts
└── eslint.config.js
```

## Tech Stack

| Component | Choice |
|---|---|
| Language | TypeScript (strict, ESM, NodeNext modules) |
| Runtime | Node.js >= 22 |
| Database | better-sqlite3 (WAL mode) |
| Encryption | AES-256-GCM (application-level, for OAuth tokens) |
| HTTP Server | Hono (bound to 127.0.0.1) |
| Agent Protocol | MCP via @modelcontextprotocol/sdk |
| Config | YAML + Zod validation |
| Gmail API | googleapis |
| GitHub API | octokit |
| Tests | Vitest |
| Package Manager | pnpm |

## Development Commands

```bash
# Build
pnpm build

# Watch mode for TypeScript
pnpm dev

# Run all tests
pnpm test

# Run tests in watch mode
pnpm test:watch

# Lint
pnpm lint
```

## Database Schema

Tables in SQLite:

| Table | Purpose |
|---|---|
| `oauth_tokens` | Encrypted OAuth tokens per source |
| `owner_auth` | Bcrypt-hashed owner password for GUI access |
| `filters` | Quick filter definitions per source (type, value, enabled) |
| `staging` | Outbound actions pending owner review |
| `audit_log` | Every data movement with timestamps and purpose |

## Key Data Types

### DataRow

The normalized shape for all source data:

```typescript
type DataRow = {
  source: string;           // "gmail", "github"
  source_item_id: string;   // original ID in source system
  type: string;             // "email", "issue", "pr", "commit"
  timestamp: string;        // ISO 8601
  data: Record<string, unknown>;  // all content fields
}
```

### QuickFilter

Stored in the `filters` table:

```typescript
type QuickFilter = {
  id: string;
  source: string;     // "gmail", "github"
  type: string;       // "time_after", "from_include", "subject_include", etc.
  value: string;      // filter value (e.g., date, sender name, field name)
  enabled: number;    // 1 = active, 0 = disabled
}
```

Available filter types: `time_after`, `from_include`, `subject_include`, `exclude_sender`, `exclude_keyword`, `has_attachment`, `hide_field`.

## How to Add a New Source Connector

1. Create `src/connectors/<source>/connector.ts` implementing `SourceConnector`:

```typescript
interface SourceConnector {
  name: string;
  fetch(boundary: SourceBoundary, params?: Record<string, unknown>): Promise<DataRow[]>;
  executeAction(actionType: string, actionData: Record<string, unknown>): Promise<ActionResult>;
}
```

2. Register the connector in `src/index.ts` by adding it to the connector registry.

3. Add MCP tools for the new source in `src/mcp/server.ts` — add a `registerXxxTools()` function and wire it to the source name in `startMcpServer()`.

4. Add tests in `src/connectors/<source>/<source>.test.ts`.

5. The connector maps source API responses into `DataRow[]` — all content goes in `data`, the four fixed fields (`source`, `source_item_id`, `type`, `timestamp`) are set at the top level.

## How Data Flows

### Pull request (`POST /app/v1/pull`)

1. Fetches live data from the connector using the configured boundary
2. Loads enabled quick filters from the `filters` table for that source
3. Applies filters: row predicates first (time_after, from_include, etc.), then field removal (hide_field)
4. Logs the access to the audit log
5. Returns the filtered data

```
Request → fetch data (live from source) → apply filters → audit log → response
```

### MCP tool call (e.g., `read_emails`)

1. Agent calls the MCP tool via stdio
2. The MCP server builds an HTTP request body from the tool arguments
3. Calls `POST /app/v1/pull` on the local HTTP server
4. Returns the JSON response as MCP text content

```
Agent → MCP stdio → fetch(hubUrl/app/v1/pull) → HTTP server → connector → filters → response
```

### Propose action (`POST /app/v1/propose`)

1. Inserts the action into the `staging` table with status `pending`
2. Logs the proposal to the audit log
3. Owner reviews in the GUI and approves/rejects
4. On approval, the connector's `executeAction` is called

## Testing

Tests are co-located with source files (`*.test.ts`) for unit tests, and in `tests/e2e/` for integration tests.

The e2e tests use an in-memory SQLite database and a mock Gmail connector (defined in `tests/e2e/helpers.ts`) so they run without external services.

To run a specific test file:

```bash
npx vitest run tests/e2e/gmail-recent-readonly.test.ts
```

To run just the MCP server tests:

```bash
npx vitest run src/mcp/server.test.ts
```

## OpenClaw Skill

The skill in `packages/personaldatahub/` is a standalone package with its own `tsconfig.json` and test suite. It wraps the PersonalDataHub API endpoints as OpenClaw tools.

To work on it:

```bash
cd packages/personaldatahub
pnpm test
```

The skill has no dependency on the main PersonalDataHub source — it only talks to the Hub over HTTP.

## MCP Server

The MCP server (`src/mcp/server.ts`) provides a stdio transport for MCP-compatible agents. It:

1. Reads `~/.pdh/config.json` for the hub URL
2. Health-checks the running HTTP server
3. Queries `GET /app/v1/sources` to discover connected sources
4. Registers source-specific tools dynamically (only for connected sources)

To test the MCP server manually:

```bash
npx pdh mcp
# Logs registered tools to stderr, then listens on stdio for MCP protocol messages
```

To add tools for a new source, add a `registerXxxTools()` function in `src/mcp/server.ts` and call it conditionally based on the source's connection status.
