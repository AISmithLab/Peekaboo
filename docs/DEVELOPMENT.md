# Development Guide

How the codebase is structured and how to modify it.

## Project Structure

```
peekaboo/
├── src/
│   ├── index.ts                 # Entry point — loads config, creates DB, starts server
│   ├── config/                  # Configuration system
│   │   ├── types.ts             # TypeScript interfaces (HubConfig, SourceConfig, etc.)
│   │   ├── schema.ts            # Zod schemas for config validation
│   │   └── loader.ts            # YAML loading with ${ENV_VAR} resolution
│   ├── db/                      # Database layer
│   │   ├── db.ts                # SQLite connection (WAL mode, foreign keys)
│   │   ├── schema.ts            # CREATE TABLE statements (5 tables)
│   │   └── encryption.ts        # AES-256-GCM encrypt/decrypt for cached data
│   ├── connectors/              # Source service integrations
│   │   ├── types.ts             # DataRow interface, SourceConnector interface
│   │   ├── gmail/
│   │   │   └── connector.ts     # Gmail fetch, executeAction, sync
│   │   └── github/
│   │       ├── connector.ts     # GitHub access validation, fetch issues/PRs
│   │       └── setup.ts         # Grant/revoke collaborator access
│   ├── fixtures/
│   │   └── emails.ts            # Synthetic demo email dataset (15 emails)
│   ├── demo.ts                  # Load/unload demo data into DB
│   ├── manifest/                # Manifest DSL
│   │   ├── types.ts             # Manifest, OperatorDecl interfaces
│   │   ├── parser.ts            # Line-oriented parser
│   │   └── validator.ts         # Graph validation, operator type checks
│   ├── operators/               # Pipeline operators
│   │   ├── types.ts             # PipelineContext, Operator interfaces
│   │   ├── registry.ts          # Maps operator type names to implementations
│   │   ├── pull.ts              # Fetch from source (cache-first)
│   │   ├── select.ts            # Keep only specified fields
│   │   ├── filter.ts            # Drop rows by condition (eq, neq, contains, gt, lt, matches)
│   │   ├── transform.ts         # Redact (regex) and truncate (max_length)
│   │   ├── stage.ts             # Insert into staging table
│   │   └── store.ts             # Upsert to encrypted cache
│   ├── pipeline/                # Pipeline engine
│   │   ├── engine.ts            # Walks @graph, executes operators in sequence
│   │   └── context.ts           # Factory for PipelineContext
│   ├── audit/
│   │   └── log.ts               # AuditLog class — typed write methods + filtered queries
│   ├── server/                  # HTTP layer
│   │   ├── server.ts            # Hono app setup, mounts API + GUI routes
│   │   └── app-api.ts           # POST /pull, POST /propose with API key auth
│   └── gui/
│       └── routes.ts            # Self-contained HTML GUI with inline JS
├── packages/
│   └── personal-data-hub/       # OpenClaw skill
│       └── src/
│           ├── index.ts         # Plugin registration
│           ├── hub-client.ts    # HTTP client for Peekaboo API
│           ├── tools.ts         # personal_data_pull, personal_data_propose tools
│           └── prompts.ts       # System prompt for teaching agents
├── tests/
│   └── e2e/                     # End-to-end integration tests
│       ├── helpers.ts           # Shared setup (mock connector, in-memory DB)
│       ├── gmail-recent-readonly.test.ts
│       ├── gmail-metadata-only.test.ts
│       ├── gmail-full-access-redacted.test.ts
│       ├── gmail-staged-action.test.ts
│       └── gmail-cache-sync.test.ts
├── docs/                        # Design docs
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
| Encryption | AES-256-GCM (application-level) |
| HTTP Server | Hono (bound to 127.0.0.1) |
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

Five tables in SQLite:

| Table | Purpose |
|---|---|
| `api_keys` | Hashed API keys for agent authentication |
| `manifests` | Stored operator pipeline definitions |
| `cached_data` | Encrypted local cache of source data (optional) |
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

### Manifest

Parsed from the DSL into:

```typescript
type Manifest = {
  purpose: string;
  graph: string[];           // ordered operator names
  operators: OperatorDecl[]; // name, type, properties
}
```

### PipelineContext

Shared context passed to all operators during execution:

```typescript
type PipelineContext = {
  db: Database;
  connectorRegistry: ConnectorRegistry;
  config: HubConfig;
  appId: string;
  manifestId: string;
  encryptionKey: string;
}
```

## How to Add a New Source Connector

1. Create `src/connectors/<source>/connector.ts` implementing `SourceConnector`:

```typescript
interface SourceConnector {
  name: string;
  fetch(boundary: Record<string, unknown>, params?: Record<string, unknown>): Promise<DataRow[]>;
  executeAction?(actionType: string, actionData: Record<string, unknown>): Promise<{ success: boolean }>;
  sync?(db: Database, encryptionKey: string): Promise<void>;
}
```

2. Register the connector in `src/index.ts` by adding it to the connector registry.

3. Add tests in `src/connectors/<source>/<source>.test.ts`.

4. The connector maps source API responses into `DataRow[]` — all content goes in `data`, the four fixed fields (`source`, `source_item_id`, `type`, `timestamp`) are set at the top level.

## How to Add a New Operator

1. Create `src/operators/<name>.ts` implementing the `Operator` interface:

```typescript
interface Operator {
  type: string;
  execute(
    rows: DataRow[],
    properties: Record<string, unknown>,
    context: PipelineContext,
  ): Promise<OperatorResult>;
}
```

2. Register it in `src/operators/registry.ts`.

3. Add tests in `src/operators/operators.test.ts`.

4. Update the manifest validator in `src/manifest/validator.ts` to recognize the new operator type.

## Manifest DSL

Access control policies are internally expressed as manifests — a line-oriented DSL that declares an operator pipeline. The GUI generates manifests from the owner's settings; developers can also write them directly.

```
@purpose: "Read-only, recent emails with SSN redaction"
@graph: pull_emails -> select_fields -> redact_sensitive
pull_emails: pull { source: "gmail", type: "email" }
select_fields: select { fields: ["title", "body", "labels", "timestamp"] }
redact_sensitive: transform { kind: "redact", field: "body", pattern: "\\d{3}-\\d{2}-\\d{4}", replacement: "[REDACTED]" }
```

### V1 Operators

| Operator | Purpose |
|---|---|
| `pull` | Fetch data from a source (live API or cache) |
| `select` | Keep only specified fields |
| `filter` | Drop rows that don't match a condition |
| `transform` | Redact patterns or truncate fields |
| `stage` | Propose an outbound action for owner review |
| `store` | Write to encrypted local cache |

## How the Pipeline Works

1. An API request hits `POST /app/v1/pull` or `/propose`
2. The server verifies the API key and resolves the matching manifest
3. The manifest is parsed into an ordered list of operators (`@graph`)
4. The pipeline engine walks the graph, passing `DataRow[]` through each operator
5. Each operator transforms the rows according to its properties
6. The final result is returned to the caller

```
Request → API key check → resolve manifest → parse graph
  → pull (fetch from source) → select (keep fields) → transform (redact/truncate)
  → response
```

## Demo Data

You can load synthetic email data to try the full pull pipeline without connecting a real Gmail account. Demo data is inserted directly into `cached_data`, so the pull operator serves it without needing OAuth or a live connector.

```bash
# Load 15 synthetic emails and 3 demo manifests
npx peekaboo demo-load

# Start the server, then pull using a demo manifest
npx peekaboo start
curl -X POST http://localhost:3000/app/v1/pull \
  -H "Authorization: Bearer <your-api-key>" \
  -H "Content-Type: application/json" \
  -d '{"manifest_id": "demo-gmail-readonly"}'

# Remove all demo data when done
npx peekaboo demo-unload
```

The three demo manifests:

| Manifest ID | Pipeline |
|---|---|
| `demo-gmail-readonly` | pull + select (title, body, labels, author_name) |
| `demo-gmail-metadata` | pull + select (title, labels, author_name only) |
| `demo-gmail-redacted` | pull + select + redact SSNs |

The `demo-gmail-redacted` manifest demonstrates redaction — two of the synthetic emails contain SSN-formatted strings that get replaced with `[SSN REDACTED]`.

Demo data is identified by prefix: emails have `source_item_id` starting with `demo_`, manifests have `id` starting with `demo-`. Loading is idempotent (safe to run multiple times).

## Testing

Tests are co-located with source files (`*.test.ts`) for unit tests, and in `tests/e2e/` for integration tests.

The e2e tests use an in-memory SQLite database and a mock Gmail connector (defined in `tests/e2e/helpers.ts`) so they run without external services.

To run a specific test file:

```bash
npx vitest run src/operators/operators.test.ts
```

## OpenClaw Skill

The skill in `packages/personal-data-hub/` is a standalone package with its own `tsconfig.json` and test suite. It wraps the two Peekaboo API endpoints as OpenClaw tools.

To work on it:

```bash
cd packages/personal-data-hub
pnpm test
```

The skill has no dependency on the main Peekaboo source — it only talks to the Hub over HTTP.
