# PersonalDataHub


PersonalDataHub is an open-source, self-hosted data hub between the services that manage your personal data (Gmail, GitHub, etc.) and your AI agents (e.g., OpenClaw). It connects to your services via secure protocols (e.g., OAuth2), and lets agents query them through REST APIs — all running locally on your machine, with no data sent to third parties. You configure access policies in natural language, filter what agents can see, and review every action they propose before it's executed.

![](architecture.png)




### How it works

1. **You connect** your accounts via OAuth2 — PersonalDataHub stores the tokens locally
2. **You define** what the agent can see: which fields, which repos, which date range, what to redact
3. **Agents call** a simple REST API (`POST /pull`, `POST /propose`) with a scoped API key
4. **You review** every outbound action (drafts, replies) before it's sent — nothing goes out without your approval

The agent never gets your OAuth tokens. It never talks to Gmail or GitHub directly. It sees nothing by default — you explicitly whitelist access.

## Quick Start

```bash
# Install dependencies
npm install

# Build
npm run build

# Initialize (creates config, database, and API key)
npx pdh init

# Start the server
npx pdh start

# Open the GUI to connect your accounts
open http://localhost:3000
```

The `init` command generates:
- `hub-config.yaml` — source configuration (OAuth credentials fetched automatically)
- `pdh.db` — SQLite database for policies, staging queue, and audit log
- An API key (`pk_xxx`) for the agent, saved to `~/.pdh/credentials.json`

## Features

### Data Sources

| Source | Read | Write |
|--------|------|-------|
| **Gmail** | Emails (filtered by date, labels) | Draft / reply / send (staged for approval) |
| **GitHub** | Issues and PRs from selected repos | Via agent's own scoped credentials |

New sources can be added by implementing the `SourceConnector` interface.

### Data Pipeline

Data passes through a configurable pipeline of operators before reaching the agent:

| Operator | Purpose |
|----------|---------|
| **pull** | Fetch from source API (or local cache) |
| **select** | Keep only specified fields (e.g., title, body, labels) |
| **filter** | Conditional filtering (equals, contains, regex, etc.) |
| **transform** | Redact patterns (SSNs, emails) or truncate text |
| **store** | Cache locally with TTL and optional AES-256-GCM encryption |
| **stage** | Queue an outbound action for owner approval |

Pipelines are defined in a simple DSL called **manifests**:

```
@purpose: "Read recent emails, redact SSNs"
@graph: fetch -> pick_fields -> redact_ssns

fetch: pull { source: "gmail", type: "email" }
pick_fields: select { fields: ["title", "body", "labels"] }
redact_ssns: transform { kind: "redact", field: "body", pattern: "\\d{3}-\\d{2}-\\d{4}", replacement: "[SSN REDACTED]" }
```

### Action Staging

When an agent wants to send an email or create a draft, the action enters a **staging queue**. Nothing is executed until you review and approve it in the GUI. You can also edit the draft before approving.

### Web GUI

A built-in admin dashboard at `http://localhost:3000` for:

- **Sources** — connect Gmail/GitHub via OAuth, configure boundaries (date range, labels, repos)
- **Manifests** — create and edit data pipelines
- **Staging** — review, edit, approve, or reject proposed agent actions
- **Settings** — manage API keys, browse the audit log, select GitHub repos

### Audit Log

Every data access and action is logged with a purpose string, timestamp, source, and initiator. Queryable from the GUI or the database directly.

## API

Two endpoints. Both require an API key (`Authorization: Bearer pk_xxx`).

### Pull Data

```
POST /app/v1/pull
```

```json
{
  "source": "gmail",
  "type": "email",
  "params": { "query": "Q4 report", "limit": 10 },
  "purpose": "Find emails about Q4 report to summarize for user"
}
```

Response data is filtered, redacted, and transformed according to the owner's access policy.

### Propose Action

```
POST /app/v1/propose
```

```json
{
  "source": "gmail",
  "action_type": "draft_email",
  "action_data": {
    "to": "bob@company.com",
    "subject": "Re: Q4 Report",
    "body": "Thanks Bob, the numbers look good."
  },
  "purpose": "Draft reply to Bob about Q4 report"
}
```

Actions are staged for owner review — not executed until approved via the GUI.

## Architecture

### Core Principles

- **Whitelist, not blacklist** — zero access by default; every piece of data, every repo, every action must be explicitly allowed
- **On-the-fly by default** — fetches from source APIs on demand; nothing written to disk unless you enable caching
- **Outbound control** — actions like sending email are staged for owner review; for sources like GitHub where the agent has its own credentials, PersonalDataHub layers additional boundary controls on top
- **Auditable** — every data movement is logged with a purpose string

### Three Layers of Access Control

1. **Credential scope** — the agent holds a scoped identity that can't access resources outside the boundary
2. **Query boundary** — the connector refuses to fetch data outside configured limits (date range, repo list, label filters)
3. **Data pipeline** — further restricts which fields are visible and redacts sensitive content before delivery

### Tech Stack

- **Runtime:** Node.js 22+
- **Framework:** [Hono](https://hono.dev)
- **Database:** SQLite via better-sqlite3
- **Auth:** PKCE OAuth (Gmail, GitHub), bcrypt API key hashing, AES-256-GCM encryption
- **Config:** YAML with Zod validation and `${ENV_VAR}` support

### Project Structure

```
src/
├── auth/           OAuth flows, PKCE, token management
├── config/         YAML config loading + Zod schema
├── connectors/     Source adapters (Gmail, GitHub)
├── db/             SQLite schema, encryption helpers
├── operators/      Pipeline operators (pull, select, filter, transform, store, stage)
├── pipeline/       Pipeline execution engine
├── manifest/       DSL parser and validator
├── server/         HTTP server + app API routes
├── gui/            Web admin dashboard
├── audit/          Immutable audit trail
├── cli.ts          CLI commands (init, start, stop, reset, demo-load)
└── index.ts        Server entrypoint

packages/
└── personal-data-hub/   Agent skill integration (tool definitions + hub client)
```

## Security Model

PersonalDataHub is designed to run on **your local machine**. The owner's OAuth tokens and encryption keys never leave the host and are never exposed to the agent.

**What the agent holds:** a PersonalDataHub API key (`pk_xxx`) that can only call the Hub API — not Gmail or GitHub directly.

**What the agent cannot do:**
- Access any data outside the configured boundary (date range, repos, labels)
- See fields not included in the manifest (e.g., sender identity can be stripped)
- Read redacted content (e.g., SSNs replaced before delivery)
- Send emails or execute actions without owner approval
- Delete anything — no destructive endpoints exist

**Known limitations:**
- Once data passes through the pipeline and reaches the agent, PersonalDataHub can't control what the agent does with it — network sandboxing at the agent runtime level is the mitigation
- A host-level compromise (attacker reads `hub-config.yaml` and `.env`) gives access to the owner's OAuth tokens and encryption keys — host-level security (disk encryption, OS access controls) is the owner's responsibility
- No built-in rate limiting yet (future enhancement)
- Agents may pretend to be a human user to interact with the hub to override the access, not sure if they are smart enough today (future enhancement).

For the full threat model with attack/mitigation tables for Gmail and GitHub, see [SECURITY.md](docs/SECURITY.md).

## Documentation

- [Setup Guide](docs/SETUP.md) — install and run PersonalDataHub
- [OAuth Setup](docs/OAUTH-SETUP.md) — OAuth credential configuration (uses PKCE for secure authorization)
- [Development Guide](docs/DEVELOPMENT.md) — codebase structure, adding connectors and operators, demo data, testing
- [Security & Threat Model](docs/SECURITY.md) — detailed attack surface analysis for Gmail and GitHub
- [Design Doc](docs/architecture-design/design.md) — full architecture and design rationale

## License

Apache 2.0
