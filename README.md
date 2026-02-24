# PersonalDataHub


PersonalDataHub is an open-source, self-hosted data hub between the services that manage your personal data (Gmail, GitHub, etc.) and your AI agents (e.g., OpenClaw). It connects to your services via secure protocols (e.g., OAuth2), and lets agents query them through REST APIs — all running locally on your machine, with no data sent to third parties. You configure quick filters to control what agents can see, and review every action they propose before it's executed.

![](architecture.png)




### How it works

1. **You connect** your accounts via OAuth2 — PersonalDataHub stores the tokens locally
2. **You configure** quick filters to control what the agent can see: date ranges, senders, subjects, hidden fields
3. **Agents call** a simple REST API (`POST /pull`, `POST /propose`) with a scoped API key
4. **You review** every outbound action (drafts, replies) before it's sent — nothing goes out without your approval

You do not need to give agents direct access to your accounts. Agents see nothing by default — you explicitly whitelist access. Install it on your Mac Mini at home or on a cloud instance alongside OpenClaw.

## Quick Start

### Option A: Install via ClawHub

If you're running [OpenClaw](https://theoperatorvault.io), install PersonalDataHub as a skill through [ClawHub](https://theoperatorvault.io/clawhub-guide):

```bash
clawhub install personaldatahub
```

That's it. Dependencies, build, init, and server startup are handled automatically. Open `http://localhost:3000` to connect your accounts.

### Option B: Install from Source

Works with or without OpenClaw.

```bash
git clone https://github.com/AISmithLab/PersonalDataHub.git
cd PersonalDataHub
pnpm install && pnpm build
npx pdh init
npx pdh start
open http://localhost:3000
```

See the [Setup Guide](docs/SETUP.md) for full details on both options, including connecting data sources and verifying your installation.

## Features

### Data Sources

| Source | Read | Write |
|--------|------|-------|
| **Gmail** | Emails (filtered by date, labels) | Draft / reply / send (staged for approval) |
| **GitHub** | Issues and PRs from selected repos | Via agent's own scoped credentials |

New sources can be added by implementing the `SourceConnector` interface.

### Quick Filters

Control what data agents can see using simple toggle-based filters in the GUI:

| Filter | What it does |
|--------|-------------|
| **Only emails after** | Drop rows before a given date |
| **Only from sender** | Keep rows where sender contains a value |
| **Subject contains** | Keep rows where subject contains a value |
| **Exclude sender** | Drop rows where sender matches |
| **Exclude subject containing** | Drop rows where subject matches |
| **Only with attachments** | Keep only rows that have attachments |
| **Hide field from agents** | Remove a field (e.g., body) before delivery |

Filters are stored in the database and applied at read time — cached data is stored unfiltered, so you can adjust filters without re-syncing.

### Caching

Data can be fetched live on every request, or cached locally with background sync:

- **Cache off** (default) — each `POST /pull` fetches directly from the source API
- **Cache on** — a background job syncs data to a local SQLite table (with optional AES-256-GCM encryption); `POST /pull` reads from the cache

### Action Staging

When an agent wants to send an email or create a draft, the action enters a **staging queue**. Nothing is executed until you review and approve it in the GUI. You can also edit the draft before approving.

### Web GUI

A built-in admin dashboard at `http://localhost:3000` for:

- **Sources** — connect Gmail/GitHub via OAuth, configure boundaries (date range, labels, repos)
- **Filters** — toggle quick filters to control what agents can see
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
  "purpose": "Find emails about Q4 report to summarize for user"
}
```

Response data is filtered according to the owner's quick filter configuration.

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

- **Zero access by default** — every piece of data, every repo, every action must be explicitly allowed
- **On-the-fly by default** — fetches from source APIs on demand; nothing written to disk unless you enable caching
- **Outbound control** — actions like sending email are staged for owner review; for sources like GitHub where the agent has its own credentials, PersonalDataHub layers additional boundary controls on top
- **Auditable** — every data movement is logged with a purpose string

### Three Layers of Access Control

1. **Credential scope** — the agent holds a scoped identity that can't access resources outside the boundary
2. **Query boundary** — the connector refuses to fetch data outside configured limits (date range, repo list, label filters)
3. **Quick filters** — further restrict which rows are visible and which fields are delivered to the agent

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
├── filters.ts      Quick filter types, catalog, and apply logic
├── sync/           Background cache sync scheduler
├── server/         HTTP server + app API routes
├── gui/            Web admin dashboard
├── audit/          Immutable audit trail
├── cli.ts          CLI commands (init, start, stop, reset, demo-load)
└── index.ts        Server entrypoint

packages/
└── personaldatahub/     Agent skill integration (tool definitions + hub client)
```

## Security Model

PersonalDataHub is designed to run on **your local machine**. The owner's OAuth tokens and encryption keys never leave the host and are never exposed to the agent.

**What the agent holds:** a PersonalDataHub API key (`pk_xxx`) that can only call the Hub API — not Gmail or GitHub directly.

**What the agent cannot do:**
- Access any data outside the configured boundary (date range, repos, labels)
- See fields hidden by quick filters (e.g., body can be stripped)
- See rows excluded by active filters (e.g., emails from specific senders)
- Send emails or execute actions without owner approval
- Delete anything — no destructive endpoints exist

**Known limitations:**
- Once data passes through filters and reaches the agent, PersonalDataHub can't control what the agent does with it — network sandboxing at the agent runtime level is the mitigation
- A host-level compromise (attacker reads `hub-config.yaml` and `.env`) gives access to the owner's OAuth tokens and encryption keys — host-level security (disk encryption, OS access controls) is the owner's responsibility
- No built-in rate limiting yet (future enhancement)
- Agents may pretend to be a human user to interact with the hub to override the access, not sure if they are smart enough today (future enhancement).

For the full threat model with attack/mitigation tables for Gmail and GitHub, see [SECURITY.md](docs/SECURITY.md).

## Documentation

- [Setup Guide](docs/SETUP.md) — install and run PersonalDataHub
- [OAuth Setup](docs/OAUTH-SETUP.md) — OAuth credential configuration (uses PKCE for secure authorization)
- [Development Guide](docs/DEVELOPMENT.md) — codebase structure, adding connectors, demo data, testing
- [Security & Threat Model](docs/SECURITY.md) — detailed attack surface analysis for Gmail and GitHub
- [Design Doc](docs/architecture-design/design.md) — full architecture and design rationale

## License

Apache 2.0
