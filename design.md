# Peekaboo: Whitelist Access to Personal Data through a Local Data Hub

## Overview

Peekaboo is a **privacy-first personal data gateway** that sits between source services (Gmail, GitHub, Calendar, etc.) and AI agents (OpenClaw). The core concept: **whitelist access to personal data**. The agent sees nothing by default — you explicitly whitelist which data it can peek at, which repos it can touch, and which actions it can take.

The Hub is an **intermediary controller** — not a simple proxy, but an active mediator that retrieves data from source services, processes it through operator pipelines locally, and serves filtered results to apps. By default, the Hub fetches data **on-the-fly** and does not store personal data locally. The user can optionally enable **local caching** per source for offline access or performance. When caching is enabled, all data is **encrypted at rest**.

Core principles:
- **Whitelist, not blacklist**: the agent has zero access by default. Every piece of data, every repo, every action must be explicitly allowed.
- **On-the-fly by default**: the Hub fetches data from source APIs on demand. Personal data passes through the pipeline and is returned — not written to disk unless the user explicitly enables caching.
- Outbound control is per-source: some sources require staging (e.g., Gmail — owner reviews before send), while others let the agent act directly through its own scoped credentials (e.g., GitHub — the agent comments/creates issues with its own account)
- The agent operates under a separate, scoped identity — even bypassing Peekaboo, the credentials limit what it can do
- Apps never touch raw data — only transformed output from operator pipelines
- Every data movement is auditable
- Keep the code simple and modular so the public can quickly validate its behavior

---

## Architecture

```
Source Services (Gmail, GitHub, etc.)
        ↑
        │ fetch (on-the-fly or from local cache)
        │
┌───────┼────────────────────────────────────────────────┐
│       │          Peekaboo                        │
│       │    (INTERMEDIARY CONTROLLER)                   │
│       │                                                │
│  ┌────┴────────────────────────────────┐               │
│  │        Operator Pipeline            │               │
│  │                                     │               │
│  │  pull ──→ select ──→ redact ──→ out │               │
│  │   ↑                                 │               │
│  │   │ on-the-fly: fetch from API      │               │
│  │   │ cached: read from local store   │               │
│  │                                     │               │
│  │  (defined by manifest,              │               │
│  │   operators are pre-loaded,         │               │
│  │   open-source, stateless)           │               │
│  └──────┬──────────────────────────────┘               │
│         │                                              │
│         │  user may inject additional                  │
│         │  operators here (e.g., extra redact)         │
│         ↓                                              │
│  ┌──────────────┐                                      │
│  │ Transformed  │  ← this is what the app sees         │
│  │ Output       │                                      │
│  └──────┬───────┘                                      │
│         │                                              │
│  ┌──────────────┐  (optional, user-enabled)            │
│  │ Local Cache  │  encrypted at rest                   │
│  │ (SQLite)     │                                      │
│  └──────────────┘                                      │
│                                                        │
│  App API (read-only, transformed data only)             │
└─────────┼──────────────────────────────────────────────┘
          ↓
   OpenClaw App (untrusted)
```

---

## Trust Model

The Hub acts as an **intermediary controller** (inspired by the OAuthHub local data hub model) that mediates all data sharing between source services and the agent. The agent operates under a **separate, restricted identity** managed by the Hub. It never holds the user's real credentials. Even if the agent bypasses the Hub API and tries to access source services directly, the scoped credentials limit what it can do.

```
                        TRUST BOUNDARY
                             │
Source Services              │         OpenClaw Agent
(Gmail, GitHub, etc.)        │         (untrusted)
        ↕                   │              │
        ↕ owner credentials  │              │ only holds scoped
        ↕ (full access)      │              │ agent credentials
        ↕                   │              │
      ┌──────────────────────────────────────────┐
      │            Peekaboo               │
      │                                          │
      │  ┌───────────┐    ┌──────────────────┐   │
      │  │  Source    │    │  Operator        │───│──→ App API (read-only)
      │  │  APIs      │──→ │  Pipeline        │   │
      │  │ (live or   │    │  (transforms     │   │
      │  │  cached)   │    │   locally)       │   │
      │  └───────────┘    └──────────────────┘   │
      │                                          │
      │  ┌───────────┐    ┌──────────────────┐   │
      │  │  Sources   │←── │  Staging Area    │←──│── App API (propose-only)
      │  │  (commit   │    │  (AI drafts,     │   │
      │  │  on audit) │    │   pending review)│   │
      │  └───────────┘    └──────────────────┘   │
      │                                          │
      │  ┌──────────────────────────────────┐    │
      │  │  Identity Manager               │    │
      │  │  (creates & manages scoped      │    │
      │  │   agent credentials per source)  │    │
      │  └──────────────────────────────────┘    │
      │                                          │
      │  ┌──────────────────────────────────┐    │
      │  │         Audit Log                │    │
      │  │  (every data movement tracked)    │    │
      │  └──────────────────────────────────┘    │
      └──────────────────────────────────────────┘
                             │
                        Human reviews
                        via Hub GUI
```

### Why Scoped Agent Identity Is Necessary

The Hub API alone is not enough. The agent runs in an environment with shell access, git CLI, curl, etc. If it holds the user's full GitHub token, it can bypass the Hub and directly:
- `git push --force` to any repo
- `gh issue close` on repos outside the allowed list
- `curl` the Gmail API with the user's OAuth token

**Solution: the agent never gets the user's real credentials.** The Hub creates a separate, scoped identity for the agent with minimum permissions. Even if the agent goes rogue and bypasses the Hub, the scoped credentials limit the blast radius.

### Two Credential Sets

```
Owner credentials (stored in Hub, never exposed to agent):
├── Gmail: OAuth token with full mailbox access
├── GitHub: PAT with access to all repos
└── Used by Hub for: on-the-fly fetches, committing approved actions

Agent credentials (issued by Hub, given to agent):
├── Gmail: restricted OAuth token or app password (send-only, no delete)
├── GitHub: fine-grained PAT scoped to specific repos with limited permissions
└── Used by agent for: direct interactions that bypass the Hub
```

The agent credentials are the **last line of defense**. The Hub API is the preferred path (manifest pipelines, staged actions). But even when the agent acts outside the Hub, the scoped credentials ensure it can't do more than what the owner allowed.

---

## Modular Privacy Flows (MPF) Integration

Based on the MPF design pattern (Haojian Jin's Ph.D. dissertation). Instead of all-or-nothing binary permissions, the GUI generates manifests with operator pipelines from the owner's access control settings. The Hub executes those pipelines as a trusted runtime.

| MPF Concept | Peekaboo Implementation |
|---|---|
| **Manifest** | GUI generates manifests from owner's access control settings. Human-readable, machine-analyzable. |
| **Operators** | Hub ships a fixed set of verb-based abstractions: pull, select, filter, transform, stage, store (V1), plus future operators like extract, aggregate, groupby, join. Each configured by properties. |
| **Trusted Runtime** | The Hub itself — an intermediary controller that retrieves data (on-the-fly or from encrypted cache), executes operator pipelines, and serves filtered results. App never touches raw data. |
| **User injection** | Owner can inject additional operators (extra redact, filter, anonymize) when approving a manifest. |
| **Auditability** | Manifests are stored and inspectable. Every query logs which operators ran. Third-party tools can analyze manifests. |
| **Outbound control** | Per-source: `stage` operator + manual commit for sources requiring review (e.g., Gmail); direct agent credentials for sources where the agent acts on its own (e.g., GitHub) |

---

## Data Model

By default, Peekaboo does **not store personal data locally**. When an app queries via the API, the Hub resolves the appropriate manifest, the `pull` operator fetches data live from the source API, the pipeline transforms it on-the-fly, and the result is returned directly.

The user can optionally **enable local caching** per source. When caching is enabled, the Hub stores fetched data in an encrypted local database, and `pull` reads from the cache instead of hitting the source API each time. This is useful for offline access, reducing API latency, or scheduled background sync. All cached data is **encrypted at rest**.

The Hub always persists staged actions locally (regardless of caching mode).

### Normalized Data Shape

The `pull` operator normalizes source API responses into a consistent shape before passing them through the pipeline. The design uses **minimal fixed fields + a flexible data map** so any source can be added without schema changes:

```typescript
type DataRow = {
  source: string;          // "gmail", "github", "slack", "gcal", etc.
  source_item_id: string;  // original ID in source system
  type: string;            // "email", "issue", "pr", "commit", "event", etc.
  timestamp: string;       // ISO 8601
  data: Record<string, unknown>;  // all content fields, flexible per source
}
```

The 4 fixed fields match the indexed columns in the `cached_data` table. All content lives in `data` — each connector defines its own field names:

| Source | Example `data` fields |
|---|---|
| Gmail | `title`, `body`, `author_name`, `author_email`, `participants`, `labels`, `url`, `attachments`, `threadId`, `isUnread`, `snippet` |
| GitHub issue/PR | `title`, `body`, `author_name`, `author_url`, `labels`, `url`, `repo`, `number`, `state`, `mergeable` |
| GitHub commit | `title`, `body`, `author_name`, `url`, `repo`, `sha`, `additions`, `deletions`, `changedFiles` |
| Calendar (future) | `title`, `start_time`, `end_time`, `location`, `attendees`, `recurrence` |
| Slack (future) | `channel`, `thread_id`, `message_text`, `sender`, `reactions` |

Operators (`select`, `filter`, `transform`) work on keys within `data`. The `select` operator narrows which fields reach the app.

### Local Tables

```
┌──────────────────────────────────────────────────────────────────────┐
│  Table                   │ App Privilege    │ Purpose                │
├──────────────────────────────────────────────────────────────────────┤
│  Cached Data Table       │ read-only        │ Local cache of source  │
│  (optional, encrypted)   │ (via manifest)   │ data. Only exists when │
│                          │                  │ user enables caching.  │
├──────────────────────────────────────────────────────────────────────┤
│  Staging Table           │ propose-only     │ Outbound actions       │
│                          │ (no commit)      │ pending owner review   │
└──────────────────────────────────────────────────────────────────────┘
```

**Cached Data Table** — encrypted at rest. Schema-flexible: raw data stored as a JSON blob so any source type works without schema changes.

| Field | Type | Description |
|---|---|---|
| `id` | string | Hub-internal ID (never exposed to apps) |
| `source` | string | Indexed for queries |
| `source_item_id` | string | Indexed, unique per source |
| `type` | string | Indexed |
| `timestamp` | datetime | Indexed for boundary filtering |
| `data` | text | JSON blob containing all content fields. **Encrypted at rest.** |
| `cached_at` | datetime | When this row was cached |
| `expires_at` | datetime | TTL-based expiration (configurable) |

**Staging Table** — apps can propose, only the owner can approve/commit:

| Column | Type | Description |
|---|---|---|
| `action_id` | string | Hub-generated ID |
| `manifest_id` | string | Which manifest generated this |
| `source` | string | Target source service |
| `action_type` | string | "send_email", "comment_on_issue", etc. |
| `action_data` | json | Action parameters and context (merged field) |
| `status` | string | "pending", "approved", "rejected", "committed" |
| `proposed_at` | datetime | When proposed |
| `resolved_at` | datetime | When approved/rejected |

This separation ensures apps cannot silently access raw data (must go through manifest pipeline with on-the-fly fetch) and cannot commit actions without owner approval.

---

## Operator Library

Each operator is like an abstract class in OOP — a verb-based abstraction whose behavior is determined by its properties. The same operator type (e.g., `transform`) can perform different transformations depending on configuration (`kind: "redact"` vs `kind: "truncate"`).

### V1 Operators (6 total)

**Read path** — fetch and transform data on-the-fly:

| Operator | What It Does | Example Properties |
|---|---|---|
| `pull` | Fetch data from a source (live API or local cache) | `source: "gmail"`, `type: "email"`, `time_window: "2w"` |
| `select` | Keep only specified columns, drop everything else | `fields: ["title", "body", "author_name"]` |
| `filter` | Drop rows that don't match a condition | `field: "labels"`, `op: "contains"`, `value: "important"` |
| `transform` | Reshape or convert values in a column | `kind: "redact"`, `kind: "truncate"` |

`pull` fetches data from the source — either live from the source API (default) or from the local cache if caching is enabled. In on-the-fly mode, the results exist only in memory for the duration of the pipeline. `filter` narrows the results further — only this repo, only this label, only open issues, only emails from a certain sender. Keeping them separate means `pull` stays simple (source + type + time window) and `filter` handles all the fine-grained row-level conditions.

**Write path** — propose actions and persist state:

| Operator | What It Does | Example Properties |
|---|---|---|
| `stage` | Propose an outbound action for owner review. Used only for sources where the owner must approve before send (e.g., Gmail). Not used for sources where the agent acts directly with its own credentials (e.g., GitHub). | `action_type: "send_email"`, `requires_approval: true` |
| `store` | Write DataRow[] to cached_data table (encrypted at rest). Upsert by (source, source_item_id). | `source: "gmail"`, `type: "email"` |

`store` writes DataRow[] to the cached_data table (encrypted at rest), upserting by (source, source_item_id). Use cases: sync cursors (track what's been processed), cached summaries.

Each operator is:
- **Stateless**: input → output, no side effects
- **Chainable**: output of one feeds into the next (pipe-and-filter)
- **Open-source**: anyone can inspect the pre-loaded implementations
- **Property-configured**: same operator type, different behavior based on properties

### Future Operators (not in V1)

| Operator | What It Would Do | When to Add |
|---|---|---|
| `aggregate` | Collapse rows into summary (count, concat) | When summary/briefing manifests are needed |
| `groupby` | Group rows by a column | Paired with `aggregate` for analytics-style queries |
| `extract` | Derive new fields from existing data (tfidf, entities) | When NLP/analysis features are needed |
| `join` | Combine results from two pipeline branches | When cross-source correlation manifests are needed |

---

## Manifest Format

Adapted from the mBrowser manifest-based query language. Each manifest is a concise, human-readable text document that declares a **directed acyclic graph (DAG)** of operators.

### Syntax

```
@purpose: "<human-readable description of why this data is needed>"
@graph: op_a -> op_b -> op_c -> op_d
// <operator_name>: <operator_type> { property_key: value, ... }
op_a: pull { source: "gmail", type: "email", time_window: "2w" }  // fetches from Gmail API or local cache
op_b: select { fields: ["title", "body", "author_name", "timestamp"] }
op_c: transform { kind: "redact", field: "body", pattern: "\\b\\d{3}-\\d{2}-\\d{4}\\b", replacement: "[SSN]" }
op_d: transform { kind: "truncate", field: "body", max_length: 5000 }
```

### Example Manifests

**Search emails:**
```
@purpose: "Find relevant emails by keyword for AI assistant"
@graph: pull_emails -> select_fields -> redact_sensitive -> truncate_body
pull_emails: pull { source: "gmail", type: "email" }
select_fields: select { fields: ["title", "body", "author_name", "author_email", "timestamp", "labels"] }
redact_sensitive: transform { kind: "redact", field: "body", pattern: "\\b\\d{3}-\\d{2}-\\d{4}\\b", replacement: "[REDACTED]" }
truncate_body: transform { kind: "truncate", field: "body", max_length: 5000 }
```

**GitHub activity summary:**
```
@purpose: "Surface recent GitHub issues and PRs for AI assistant"
@graph: pull_github -> select_fields -> redact_creds
pull_github: pull { source: "github", type: "issue,pr", time_window: "1w" }
select_fields: select { fields: ["title", "body", "author_name", "labels", "url", "timestamp"] }
redact_creds: transform { kind: "redact", field: "body", pattern: "(?i)(password|secret|token)\\s*[:=]\\s*\\S+", replacement: "[REDACTED]" }
```

**Propose outbound action:**
```
@purpose: "Draft email replies for owner review"
@graph: stage_it
stage_it: stage { action_type: "send_email", requires_approval: true }
```

### Why This Format

- **One line per operator** — easy to read, easy to diff, easy to audit
- **`@graph` declares the DAG** — the full data flow is visible in a single line
- **`@purpose` is mandatory** — describes why this data access is needed
- **Property-configured** — the same small set of operator types covers many use cases without enumerating hundreds of permissions
- **Machine-analyzable** — third-party tools, auditors, or the Hub UI can parse manifests and generate natural language descriptions (e.g., "this app reads your Gmail emails from the last 2 weeks, keeps only title/body/sender, redacts SSNs, and truncates to 5000 chars")
- **User-injectable** — the owner can insert additional operators into the `@graph` line without the app's involvement

---

## API Design

### App API Surface

A single API surface (`/app/v1/`) for external apps like OpenClaw. The owner interacts with Peekaboo directly through the GUI (no separate Owner API needed).

### Response Envelope

```typescript
type HubResponse<T> = {
  ok: boolean;
  data: T;
  cursor?: string;        // for pagination
  meta?: {
    total?: number;
    sources?: string[];
    manifest?: string;       // which manifest was executed
    graph?: string;          // the effective operator graph
    operatorsApplied?: string[];
    queryTimeMs?: number;
  };
  error?: { code: string; message: string };
}
```

### App API Endpoints

Only **2 endpoints**. Policies are configured through the GUI (which generates manifests internally). Apps just send requests with a `purpose` string — they never see manifests or policies. The purpose is stored in the audit log. Both endpoints require an API key (`Authorization: Bearer pk_xxx`).

```
POST   /app/v1/pull                          # pull data from a source (requires purpose)
POST   /app/v1/propose                       # propose an outbound action (requires purpose, staged for owner review)
```

---

## API Examples

### Pull Data

```json
// POST /app/v1/pull
{
  "source": "gmail",
  "type": "email",
  "params": {
    "query": "Q4 report",
    "limit": 10
  },
  "purpose": "Find emails about Q4 report to summarize for user"
}

// Response — only data allowed by the policy (configured via GUI)
// Fields may be filtered, redacted, or truncated based on the owner's settings
{
  "ok": true,
  "data": [
    {
      "title": "Q4 Report Draft",
      "body": "Hi team, here's the Q4 report. Revenue was $2.3M... [truncated at 5000 chars]",
      "timestamp": "2026-02-19T10:00:00Z",
      "labels": ["inbox", "important"]
    }
  ]
}
```

### Propose Action (Outbound)

```json
// POST /app/v1/propose
{
  "source": "gmail",
  "action_type": "draft_email",
  "action_data": {
    "to": "alice@company.com",
    "subject": "Re: Q4 Report Draft",
    "body": "Thanks Alice, the numbers look good."
  },
  "purpose": "Draft reply to Alice about Q4 report as requested by user"
}

// Response
{
  "ok": true,
  "actionId": "act_def456",
  "status": "pending_review"
}
```

---

## Audit Log

Every data movement is recorded, including the **purpose** provided by the app:

```json
{
  "entries": [
    {
      "timestamp": "2026-02-20T14:30:00Z",
      "event": "data_pull",
      "source": "gmail",
      "purpose": "Find emails about Q4 report to summarize for user",
      "resultsReturned": 3,
      "initiatedBy": "app:openclaw"
    },
    {
      "timestamp": "2026-02-20T14:32:15Z",
      "event": "action_proposed",
      "actionId": "act_def456",
      "source": "gmail",
      "action_type": "draft_email",
      "purpose": "Draft reply to Alice about Q4 report as requested by user",
      "initiatedBy": "app:openclaw"
    },
    {
      "timestamp": "2026-02-20T14:45:00Z",
      "event": "action_approved",
      "actionId": "act_def456",
      "initiatedBy": "owner"
    },
    {
      "timestamp": "2026-02-20T14:45:01Z",
      "event": "action_committed",
      "actionId": "act_def456",
      "source": "gmail",
      "result": "success"
    }
  ]
}
```

---

## PersonalDataHub OpenClaw Extension

The **PersonalDataHub** extension connects OpenClaw to Peekaboo. It does not know about manifests or policies — it simply sends requests with a `purpose` string. The Hub resolves the appropriate policy (configured by the owner via GUI) and logs the purpose in the audit database.

**Extension registration:**

```typescript
register(api: OpenClawExtensionApi) {
  const hub = new HubClient(cfg.hubUrl, cfg.apiKey);

  // Tool: pull personal data
  api.registerTool({
    name: "personal_data_pull",
    description: "Pull personal data (emails, etc.) from Peekaboo Hub. Must include a purpose.",
    parameters: Type.Object({
      source: Type.String({ description: "Data source: 'gmail'" }),
      type: Type.Optional(Type.String({ description: "Data type: 'email'" })),
      params: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
      purpose: Type.String({ description: "Why you need this data" })
    }),
    async execute(_id, params) {
      const res = await hub.pull(params.source, params.type, params.params, params.purpose);
      return {
        content: [{ type: "text", text: formatResults(res.data) }]
      };
    }
  });

  // Tool: propose outbound action (staged for owner review)
  api.registerTool({
    name: "personal_data_propose",
    description: "Propose an action (e.g., draft email). Staged for owner review — not sent immediately.",
    parameters: Type.Object({
      source: Type.String({ description: "Target source: 'gmail'" }),
      action_type: Type.String({ description: "Action: 'draft_email', 'send_email', 'reply_email'" }),
      action_data: Type.Record(Type.String(), Type.Unknown()),
      purpose: Type.String({ description: "Why you are proposing this action" })
    }),
    async execute(_id, params) {
      const res = await hub.propose(params.source, params.action_type, params.action_data, params.purpose);
      return {
        content: [{
          type: "text",
          text: `Action staged (${res.actionId}). Owner must review and approve.`
        }]
      };
    }
  });

}
```

---

## Security Summary

| Concern | How the Hub handles it |
|---|---|
| Agent bypasses Hub and accesses services directly | Agent holds scoped credentials (separate identity) with minimum permissions. Even bypassing the Hub, the agent can only access what the credentials allow. |
| Agent destroys a repo or deletes emails | Agent's GitHub PAT has no admin/delete/push permissions. Agent's Gmail token has no delete scope. Enforced by the source service itself. |
| Agent accesses repos/emails outside the boundary | Agent credentials are scoped to specific repos. Gmail boundary starts from a date cutoff. The Hub refuses to fetch data outside the boundary AND the agent's credentials can't reach it. |
| App overwrites/deletes source data via Hub | Hub API has no write access to sources. Only `propose` through `stage` operator. Owner must approve. |
| AI sees everything | AI only sees data that passed through approved operator pipelines. Manifest controls what fields, redactions, and transformations apply. |
| Data at rest exposure | By default, no personal data is stored locally. When caching is enabled, all cached data is encrypted at rest. Cache TTL ensures stale data is purged. |
| Accidental send | Depends on source. Gmail: all outbound actions are staged — owner reviews before send. GitHub: writes go directly through the agent's own scoped GitHub credentials (fine-grained PAT), which limit repos and permissions. No staging, but the credential scope constrains the blast radius. |
| Unknown app exfiltrating data | Audit log tracks every query with purpose. Manifests are inspectable. Operators are open-source. |
| Centralized control | One place to connect/disconnect sources, manage agent identities, review manifests, approve actions, read audit log. |
| Gradual trust | Per-repo permission levels on agent identity. `autoApprove` per action type. Start fully restricted, relax over time. |
| Fine-grained privacy | Three layers: credential scope (identity), query boundary (config), manifest pipeline (operators). Local caching opt-in with encryption at rest. |

---

## V1 Use Cases: Gmail and GitHub

The first version of Peekaboo supports two source connectors. Both enforce **user-defined boundaries** at the source connector level — the `pull` operator applies boundary constraints as query parameters when fetching from the source API.

### Source Configuration

The owner configures each source via `hub-config.yaml`. Each source has four sections:
- **`owner_auth`**: the owner's full credentials (used by the Hub for fetches and committing approved actions)
- **`agent_identity`**: the scoped credentials the Hub provisions for the agent
- **`boundary`**: access boundaries that control what data the `pull` operator can fetch
- **`cache`** (optional): enable local caching with encryption at rest, sync interval, and TTL

```yaml
# hub-config.yaml

sources:
  gmail:
    enabled: true

    # Owner's credentials — stored in Hub, NEVER exposed to agent
    owner_auth:
      type: oauth2
      clientId: "${GMAIL_CLIENT_ID}"
      clientSecret: "${GMAIL_CLIENT_SECRET}"

    # Agent identity — Hub creates/manages this, agent receives it
    agent_identity:
      # Option A: separate Google account for the agent
      type: delegated_account
      email: "my-ai-agent@gmail.com"
      permissions:
        - send_as: "myemail@gmail.com"    # can send on behalf of owner
        # no delete, no modify, no read-all — only what Hub grants

      # Option B: app-specific password with limited scope
      # type: app_password
      # scopes: ["gmail.send"]            # send only, no read/delete

    # ── Access boundary (applied at query time) ──
    boundary:
      after: "2026-01-01"                 # only emails on or after this date
      # labels: ["inbox", "important"]
      # exclude_labels: ["spam", "trash"]

    # ── Local caching (optional, disabled by default) ──
    # cache:
    #   enabled: true
    #   sync_interval: 30m              # how often to refresh the cache
    #   ttl: 7d                         # expire cached items after 7 days
    #   encrypt: true                   # encrypt at rest (default: true when caching)

  github:
    enabled: true

    # Owner's credentials — stored in Hub, NEVER exposed to agent
    owner_auth:
      type: personal_access_token
      token: "${GITHUB_PAT}"              # full access to all repos

    # Agent identity — a separate GitHub identity with scoped access
    agent_identity:
      type: fine_grained_pat
      # The Hub creates a fine-grained PAT (or uses a GitHub App installation)
      # scoped to ONLY the allowed repos with ONLY the allowed permissions
      github_username: "my-ai-agent"      # separate GitHub account for the agent
      repos:
        - repo: "myorg/frontend"
          permissions: ["issues:read", "issues:write", "pull_requests:read", "contents:read"]
        - repo: "myorg/api-server"
          permissions: ["issues:read", "pull_requests:read", "contents:read"]
        - repo: "personal/dotfiles"
          permissions: ["contents:read"]   # read-only, no write at all
      # NOT granted: repo deletion, admin, settings, workflow, pages, etc.

    # ── Access boundary (applied at query time) ──
    boundary:
      repos:
        - "myorg/frontend"
        - "myorg/api-server"
        - "personal/dotfiles"
      types: ["issue", "pr", "commit"]

    # ── Local caching (optional, disabled by default) ──
    # cache:
    #   enabled: true
    #   sync_interval: 15m
    #   ttl: 3d
```

### How Boundaries Are Enforced — Three Layers

```
Source API (Gmail, GitHub)
        ↑
        │  Layer 1 — CREDENTIAL SCOPE (identity manager):
        │  Agent's GitHub PAT can only access 3 repos.
        │  Agent's Gmail token can only send, not delete.
        │  Even if agent bypasses Hub, credentials are limited.
        │
        │  Layer 2 — QUERY BOUNDARY (source connector):
        │  Gmail: WHERE date >= boundary.after
        │  GitHub: WHERE repo IN boundary.repos
        │  The connector refuses to fetch data outside the boundary.
        │
   ┌────┴────────────────────────────┐
   │  Data retrieval                  │
   │  (on-the-fly from API, or       │
   │   from encrypted local cache)   │
   │  (normalized to common shape)   │
   └────────────┬────────────────────┘
                │
                │  Layer 3 — MANIFEST PIPELINE (operators):
                │  pull -> select -> transform -> ...
                │  Further restricts columns, redacts content.
                ↓
        App receives transformed output
```

Three layers of protection:
1. **Credential scope** (identity-level): the agent holds a scoped identity that physically cannot access resources outside the boundary. This is the **last line of defense** — even if the agent bypasses the Hub entirely, the credentials limit what it can do.
2. **Query boundary** (config-level): the connector refuses to fetch data outside the configured boundary. The `pull` operator applies boundary constraints as query parameters to the source API (or as filters on the local cache).
3. **Manifest pipeline** (operator-level): even within fetched data, the manifest further restricts what columns are visible, redacts sensitive content, etc.

The agent cannot influence any of these layers. Layer 1 is enforced by the source service itself (GitHub, Google). Layer 2 is enforced by the Hub's source connector. Layer 3 is enforced by the Hub's operator runtime. When caching is disabled (the default), no personal data is persisted. When caching is enabled, all cached data is encrypted at rest.

---

### Gmail Connector

**What gets fetched:**

The Gmail connector queries the Gmail API when a `pull` operator targets `source: "gmail"`. It applies the configured boundary (e.g., `after` date) as Gmail API query parameters, fetches matching emails, and normalizes them into the common row shape. If local caching is enabled, the connector syncs data to the encrypted cache at the configured interval and `pull` reads from the cache instead.

| Field | Gmail Mapping |
|---|---|
| `source` | `"gmail"` |
| `source_item_id` | Gmail message ID |
| `type` | `"email"` |
| `title` | Subject line |
| `body` | Email body (plaintext preferred, HTML stripped) |
| `timestamp` | Date header |
| `author_name` | From: display name |
| `author_email` | From: email address |
| `participants` | `[{name, email, role: "to"/"cc"/"bcc"}]` |
| `labels` | Gmail labels (`["inbox", "important", ...]`) |
| `url` | `https://mail.google.com/mail/u/0/#inbox/<id>` |
| `attachments` | `[{name, mimeType, sizeBytes}]` (metadata only, not content) |
| `threadId`, `isUnread`, `snippet`, `inReplyTo` | Included in `data` (same level as other fields) |

**Example: user sets `boundary.after: "2026-01-01"`**

```
User's Gmail
├── 2025-11-15  "Old project thread"     ← NOT fetchable (before cutoff)
├── 2025-12-20  "Holiday plans"          ← NOT fetchable (before cutoff)
├── 2026-01-03  "Q1 kickoff"             ← fetchable
├── 2026-01-15  "Budget review"          ← fetchable
├── 2026-02-10  "Q4 report draft"        ← fetchable
└── 2026-02-19  "Deployment failed"      ← fetchable
```

When a manifest runs, the `pull` operator queries Gmail with `after:2026/01/01`, fetches matching emails, normalizes them, and passes them through the rest of the pipeline. In on-the-fly mode (default), data exists only in memory during execution. With caching enabled, data is stored locally encrypted and refreshed at the configured interval.

**Outbound actions (staged):**

| Action Type | What It Does | Staged? |
|---|---|---|
| `send_email` | Send a new email | Yes — owner reviews before send |
| `reply_email` | Reply to a thread | Yes — owner reviews before send |
| `draft_email` | Create a draft in Gmail | Yes — owner reviews before creating |

---

### GitHub Connector

**What gets fetched:**

Peekaboo controls **read access only** for GitHub. The GitHub connector queries the GitHub API (using the owner's credentials) when a `pull` operator targets `source: "github"`. It only fetches from repos listed in `boundary.repos`. If local caching is enabled, the connector syncs to the encrypted cache at the configured interval.

**Outbound actions** (commenting on issues, creating issues) are **not staged through Peekaboo**. Instead, the agent uses its own scoped GitHub credentials (a fine-grained PAT for a separate GitHub account) to perform writes directly. The agent's credentials are scoped to specific repos with limited permissions, so the blast radius is inherently constrained by GitHub itself.

| Field | GitHub Mapping |
|---|---|
| `source` | `"github"` |
| `source_item_id` | `"myorg/frontend#123"` or commit SHA |
| `type` | `"issue"`, `"pr"`, or `"commit"` |
| `title` | Issue/PR title, or commit message first line |
| `body` | Issue/PR body (markdown), or full commit message |
| `timestamp` | Created/committed date |
| `author_name` | GitHub username |
| `author_url` | `https://github.com/<username>` |
| `participants` | Assignees, reviewers |
| `labels` | Issue/PR labels (`["bug", "P0", ...]`) |
| `url` | `https://github.com/myorg/frontend/issues/123` |
| `repo`, `number`, `state`, `branch`, `mergeable`, `additions`, `deletions`, `changedFiles` | Included in `data` (same level as other fields) |

**Repo boundary enforcement (three layers):**

```
User's GitHub repos              Agent's GitHub identity
                                 (fine-grained PAT: my-ai-agent)
                                 Can ONLY access:
                                   myorg/frontend     (issues:rw, prs:r, contents:r)
                                   myorg/api-server   (issues:r, prs:r, contents:r)
                                   personal/dotfiles  (contents:r)

├── myorg/frontend          ← Agent credential has access ← Hub can fetch ← manifest can query
│   ├── Issue #42           ← fetchable, queryable
│   ├── PR #87              ← fetchable, queryable
│   └── Commit abc123       ← fetchable, queryable
├── myorg/api-server        ← Agent credential has access ← Hub can fetch ← manifest can query
│   └── Issue #15           ← fetchable, queryable
├── personal/dotfiles       ← Agent credential: read-only ← Hub can fetch ← manifest can query
├── myorg/billing-service   ← Agent credential: NO ACCESS  ← NOT fetchable
├── myorg/infra-terraform   ← Agent credential: NO ACCESS  ← NOT fetchable
└── personal/secret-project ← Agent credential: NO ACCESS  ← NOT fetchable
```

Even if the agent bypasses the Hub and runs `git clone myorg/billing-service` directly, the agent's GitHub PAT doesn't have access to that repo — the clone fails. The identity boundary is enforced by GitHub itself. And within the Hub, no data from excluded repos is ever fetched or held in memory.

Within allowed repos, permissions are also scoped:
- `myorg/frontend`: agent can read issues/PRs/code, and write issues (comment, create). Cannot push code, merge PRs, change settings.
- `myorg/api-server`: agent can read only. Cannot write anything.
- `personal/dotfiles`: agent can read code only. Cannot create issues or write anything.

**Outbound actions (direct via agent's GitHub account):**

The agent performs GitHub writes (commenting on issues, creating issues) directly using its own scoped GitHub credentials — these actions are **not staged** through the Hub. The agent's fine-grained PAT limits which repos it can write to and what permissions it has. For example, the agent can comment on issues in `myorg/frontend` (where it has `issues:write`) but cannot write anything to `myorg/api-server` (where it only has read access). This is enforced by GitHub itself.

**What the agent cannot do, even if it bypasses the Hub:**

| Action | Blocked by |
|---|---|
| Push code to any repo | Agent PAT has no `contents:write` permission |
| Merge a PR | Agent PAT has no `pull_requests:write` permission |
| Delete a branch | Agent PAT has no `contents:write` permission |
| Change repo settings | Agent PAT has no `administration` permission |
| Access unlisted repos | Agent PAT is scoped to 3 repos only |
| Access org-level settings | Agent PAT has no `organization` permissions |

---

### V1 Example Manifests

The following are example manifests showing what the GUI generates from presets:

**`email-search.manifest`** — search emails:
```
@purpose: "Search emails by keyword for AI assistant"
@graph: pull_emails -> select_fields -> redact_sensitive -> truncate_body
pull_emails: pull { source: "gmail", type: "email" }
select_fields: select { fields: ["title", "body", "author_name", "author_email", "timestamp", "labels"] }
redact_sensitive: transform { kind: "redact", field: "body", pattern: "\\b\\d{3}-\\d{2}-\\d{4}\\b", replacement: "[REDACTED]" }
truncate_body: transform { kind: "truncate", field: "body", max_length: 5000 }
```

**`github-issues.manifest`** — search issues and PRs:
```
@purpose: "Search GitHub issues and PRs in allowed repos"
@graph: pull_items -> select_fields -> redact_secrets
pull_items: pull { source: "github", type: "issue,pr" }
select_fields: select { fields: ["title", "body", "author_name", "labels", "url", "timestamp", "repo", "number", "state"] }
redact_secrets: transform { kind: "redact", field: "body", pattern: "(?i)(password|secret|token|key)\\s*[:=]\\s*\\S+", replacement: "[REDACTED]" }
```

**`github-commits.manifest`** — recent commit history:
```
@purpose: "View recent commits in allowed repos"
@graph: pull_commits -> select_fields
pull_commits: pull { source: "github", type: "commit", time_window: "1w" }
select_fields: select { fields: ["title", "author_name", "timestamp", "url", "repo", "sha"] }
```

**`propose-email-reply.manifest`** — draft email reply:
```
@purpose: "Draft an email reply for owner review before sending"
@graph: stage_it
stage_it: stage { action_type: "reply_email", requires_approval: true }
```

---

### V1 End-to-End Walkthrough

**Setup:**
```
1. Owner opens Peekaboo GUI in browser (http://localhost:PORT)
2. Owner connects Gmail (OAuth flow) and GitHub (enters PAT)
3. Owner configures boundaries via GUI:
   - Gmail: only emails after 2026-01-01
   - GitHub: repos ["myorg/frontend", "myorg/api-server"]
4. Owner configures access control policies via GUI
   (GUI generates manifests internally from these settings)
```

**Usage — "find emails about the deployment failure":**
```
User (via Telegram): "What emails do I have about the deployment failure?"
  → Agent calls personal_data_pull({ source: "gmail", type: "email",
      params: { query: "deployment failure" },
      purpose: "Find emails about deployment failure to summarize for user" })
  → Hub resolves policy (configured via GUI), fetches from Gmail API (or local cache):
    pull(gmail, email) -> select(6 fields) -> redact(SSNs) -> truncate(5000)
  → Returns 3 matching emails (only post-2026-01-01, only selected fields, SSNs redacted)
  → Agent summarizes and replies
```

**Usage — "what's happening in the frontend repo":**
```
User: "Any open bugs in the frontend repo?"
  → Agent calls personal_data_pull({ source: "github", type: "issue",
      params: { query: "bug state:open repo:myorg/frontend" },
      purpose: "Find open bugs in frontend repo for user" })
  → Hub resolves policy, fetches from GitHub API (or local cache):
    pull(github, issue+pr) -> select(7 fields) -> redact(secrets)
  → Returns issues from myorg/frontend only (Hub refuses to fetch from myorg/billing-service)
  → Agent summarizes and replies
```

**Usage — "reply to Alice's email" (staged via Hub):**
```
User: "Draft a reply to Alice's Q4 report email saying the numbers look good"
  → Agent calls personal_data_propose({ source: "gmail", action_type: "reply_email",
      action_data: { inReplyTo: "hub_abc123", body: "Thanks Alice, the numbers look good." },
      purpose: "Draft reply to Alice about Q4 report as requested by user" })
  → Hub stages the action, returns "pending"
  → Agent tells user: "Draft staged. Please review in your Hub dashboard."
  → Owner opens Hub GUI, reads the draft, clicks Approve
  → Hub sends the email via Gmail API
```

**Usage — "comment on a GitHub issue" (direct via agent's GitHub account):**
```
User: "Add a comment to frontend issue #42 saying we'll fix it in the next sprint"
  → Agent uses its own GitHub credentials (fine-grained PAT for my-ai-agent)
  → Agent posts comment directly to myorg/frontend#42 via GitHub API
  → No staging needed — the agent's scoped PAT limits which repos and actions are allowed
  → If the agent tried to comment on myorg/api-server (read-only), GitHub would reject it
```

---

## Tech Stack

| Component | Choice | Why |
|---|---|---|
| Language | TypeScript | Same ecosystem as OpenClaw; shared types between Hub and app |
| Runtime | Node.js ≥22 | Stable, good library ecosystem for Gmail/GitHub APIs |
| Database | better-sqlite3 | Staging, audit log, manifests, and optional local cache |
| Encryption at rest | SQLCipher or application-level AES-256-GCM | Encrypts the local cache when caching is enabled |
| HTTP server | Hono | Lightweight, fast, TypeScript-native, easy to audit |
| Config | YAML (yaml) | Human-readable config files |
| Validation | Zod | Config and API request/response validation |
| Gmail API | googleapis | Official Google API client |
| GitHub API | octokit | Official GitHub API client |
| Manifest parser | Custom (hand-written) | Simple line-oriented DSL, no parser generator needed |
| Package manager | pnpm | Same as OpenClaw |

### Project Structure

```
peekaboo/
├── src/
│   ├── index.ts                    # entry point
│   ├── server/                     # HTTP server
│   │   ├── server.ts               # Hono app setup
│   │   └── app-api.ts              # /app/v1/* routes
│   ├── db/
│   │   ├── schema.ts               # table definitions (cached_data, staging)
│   │   ├── encryption.ts           # encryption at rest for local cache
│   │   └── db.ts                   # SQLite connection
│   ├── connectors/
│   │   ├── types.ts                # SourceConnector interface + normalized DataRow shape
│   │   ├── gmail/
│   │   │   ├── connector.ts        # Gmail sync logic
│   │   │   ├── mapper.ts           # Gmail message → normalized DataRow
│   │   │   └── actions.ts          # send_email, reply_email execution
│   │   └── github/
│   │       ├── connector.ts        # GitHub sync logic
│   │       ├── mapper.ts           # Issue/PR/Commit → normalized DataRow
│   │       └── actions.ts          # comment_on_issue, create_issue execution
│   ├── manifest/
│   │   ├── parser.ts               # parse .manifest files
│   │   ├── validator.ts            # validate operator graph
│   │   └── types.ts                # Manifest, Operator, Graph types
│   ├── operators/
│   │   ├── types.ts                # Operator interface
│   │   ├── registry.ts             # operator registry
│   │   ├── pull.ts                 # pull: fetch rows live from source API
│   │   ├── select.ts               # select: keep only specified columns
│   │   ├── filter.ts               # filter: drop rows by condition
│   │   ├── transform.ts            # transform: redact, truncate
│   │   ├── stage.ts                # stage: propose outbound action
│   │   └── store.ts                # store: write to cached_data
│   ├── pipeline/
│   │   ├── engine.ts               # assemble and execute operator graph
│   │   └── context.ts              # pipeline execution context
│   ├── config/
│   │   ├── schema.ts               # Zod schema for hub-config.yaml
│   │   ├── loader.ts               # load and validate config
│   │   └── types.ts                # Config types
│   ├── audit/
│   │   └── log.ts                  # audit log writes
│   └── gui/
│       ├── routes.ts               # GUI routes (serves frontend, handles API)
│       └── frontend/               # GUI frontend (Preact + Vite)
├── hub-config.example.yaml
├── package.json
├── tsconfig.json
└── README.md
```

### Key Dependencies (keep minimal for auditability)

```json
{
  "dependencies": {
    "better-sqlite3": "^11.0.0",
    "hono": "^4.0.0",
    "@hono/node-server": "^1.0.0",
    "googleapis": "^140.0.0",
    "octokit": "^4.0.0",
    "zod": "^3.23.0",
    "yaml": "^2.4.0",
    "preact": "^10.0.0"
  },
  "devDependencies": {
    "typescript": "^5.5.0",
    "vitest": "^2.0.0",
    "vite": "^6.0.0",
    "@types/better-sqlite3": "^7.0.0"
  }
}
```

---

*Initial design: 2026-02-20*
*Tech stack decided: 2026-02-21*
