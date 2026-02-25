# PersonalDataHub v1 Design

## What changed from v0

v0 had a cache layer, per-agent API keys, and an OpenClaw-specific plugin for tool discovery. This redesign removes cache, removes API keys, adds owner authentication, and exposes tools via MCP with source-specific names.

### Removed
- **Cache layer** — `cached_data` table, background sync scheduler, encryption for cached data. `POST /pull` always fetches live from the connector.
- **Per-agent API keys** — the `api_keys` table, bcrypt auth middleware, `~/.pdh/credentials.json` key field, and the auto-key-creation dance. Agents no longer need credentials to call the Hub.

### Added
- **Owner authentication** — password-based login for the GUI, session cookie for admin endpoints.
- **MCP server interface** — PersonalDataHub exposes tools via the Model Context Protocol, making it work with any MCP-compatible agent (Claude Code, Cursor, Windsurf, OpenClaw, etc.).
- **Source-specific tool names** — `read_emails`, `search_github_issues`, `draft_email` instead of generic `personal_data_pull` / `personal_data_propose`.

---

## Architecture overview

```
┌──────────────────────────────────────────────────────────┐
│                    Owner's machine                       │
│                                                          │
│  ┌────────────────────┐     ┌─────────────────────────┐  │
│  │  personaldatahub    │     │  main user              │  │
│  │  user               │     │                         │  │
│  │  PersonalDataHub    │◄────│  Agent (OpenClaw)       │  │
│  │  server             │     │  Agent (Claude Code)    │  │
│  │  pdh.db             │     │  Agent (Cursor)         │  │
│  │  OAuth tokens       │     │  Owner's browser ──►    │  │
│  │  (0600 perms)       │     │    (login via password) │  │
│  └────────┬───────────┘     └─────────────────────────┘  │
│           │                                              │
│           │ OAuth (owner's tokens)                       │
│           ▼                                              │
│  ┌────────────────────┐                                  │
│  │ Gmail API          │                                  │
│  │ GitHub API         │                                  │
│  └────────────────────┘                                  │
└──────────────────────────────────────────────────────────┘
```

### Process isolation

PersonalDataHub runs as a **dedicated OS user** (`personaldatahub`). The database, OAuth tokens, and config files are owned by this user with `0600` permissions. Neither the owner's main account nor agent processes can read these files directly — all access goes through the HTTP interface.

This matters because the SQLite DB contains **OAuth refresh tokens** for Gmail and GitHub. A compromised agent that can read the DB file could call the Gmail API directly, bypassing all PersonalDataHub controls. Running PersonalDataHub as a separate user prevents this.

### Who can reach the server

The server binds to `127.0.0.1` (localhost only). Any process on the machine can connect — agents, the owner's browser, any local program. The server distinguishes between them by **what endpoints they can access**, not by who they are.

---

## Authentication model

### Two tiers of access

| Tier | Who | Auth required | Can do |
|------|-----|---------------|--------|
| **Agent API** | Any localhost process | None | `POST /pull`, `POST /propose` — read data (filtered), propose actions (staged) |
| **Admin GUI** | Owner only | Session cookie | Connect OAuth, configure filters, approve/reject actions, view audit log, manage settings |

### Why agents don't need auth

Agents are **constrained server-side**, not authenticated:
- **Quick filters** control what data agents see (owner configures via GUI)
- **Staging** ensures agents cannot execute actions — they can only propose, and the owner must approve
- **Audit log** records every pull and propose with purpose strings

A malicious agent with localhost access can read filtered data and propose actions, but it cannot: approve its own actions, change filters, access OAuth tokens, or see unfiltered data. The server enforces this regardless of the caller's identity.

### Why the GUI needs auth

The GUI endpoints are powerful:
- Connect/disconnect OAuth (grants access to Gmail, GitHub)
- Modify quick filters (controls what agents see)
- Approve/reject staged actions (sends emails on the owner's behalf)
- View raw audit log

Without auth, any local process could approve agent actions, weaken filters, or disconnect OAuth. The session cookie ensures only the owner (via browser) can perform these operations.

### Owner login flow

The owner authenticates with a **password** set during `npx pdh init`.

```
npx pdh init
  → creates `personaldatahub` OS user (requires sudo)
  → prompts for a password (or generates one)
  → stores bcrypt hash in pdh.db (owner_auth table)
  → server starts as `personaldatahub` user

Owner switches to personaldatahub account (su personaldatahub / login)
  → opens browser in personaldatahub user's session
  → navigates to http://localhost:3000
  → login page → types password
  → server verifies against bcrypt hash
  → sets HttpOnly session cookie
  → admin GUI accessible for this browser session
  → configures filters, connects OAuth, approves actions
```

The browser runs in the `personaldatahub` user's own desktop session, fully isolated from agent processes running under the main user account.

**X11 keylogging is not a concern.** The owner types the password in a browser running under the **`personaldatahub` OS account**, which has its own X11/Wayland session with its own `~/.Xauthority`. Agent processes run under the **main user account** in a separate session. X11 does not allow cross-user keyboard capture — agents cannot access the `personaldatahub` user's display or keyboard events. The OS user separation protects both the DB files (file permissions) and the keyboard input (session isolation).

---

## MCP server interface

### Why MCP

The v0 OpenClaw plugin required a specific plugin framework. Agents that don't use OpenClaw (Claude Code, Cursor, Windsurf, custom agents) couldn't discover PersonalDataHub tools. MCP is the emerging standard for tool discovery — one implementation works everywhere.

### Tool design: source-specific names

v0 had two generic tools (`personal_data_pull`, `personal_data_propose`). Agents often failed to invoke them because the tool name didn't match the user's request ("check my emails" → ???).

v1 registers **source-specific tools** with names that match natural language:

#### Read tools

| Tool name | Description | Source |
|-----------|-------------|--------|
| `read_emails` | Read emails from Gmail. Returns filtered, redacted email data. | gmail |
| `search_github_issues` | Search issues across allowed GitHub repos. | github |
| `search_github_prs` | Search pull requests across allowed GitHub repos. | github |

#### Write tools (all staged for owner approval)

| Tool name | Description | Source |
|-----------|-------------|--------|
| `draft_email` | Create a draft email. Staged for owner review. | gmail |
| `send_email` | Send an email. Staged for owner review. | gmail |
| `reply_to_email` | Reply to an email thread. Staged for owner review. | gmail |

#### Common parameters

Every tool requires a `purpose` string explaining why the data is needed or the action is being proposed. This is logged for audit.

Read tools accept optional filtering parameters:
- `query` — source-native search syntax (e.g., `is:unread from:alice`)
- `limit` — max results to return

Write tools accept the action-specific fields (`to`, `subject`, `body`, `in_reply_to`).

### MCP server setup

The MCP server runs as part of the PersonalDataHub process (same port, different transport):

```
PersonalDataHub server (localhost:3000)
  ├── HTTP endpoints (GUI, agent API)
  └── MCP endpoint (stdio or SSE transport)
```

Agents configure PersonalDataHub as an MCP server:

```json
// Claude Code: ~/.claude/claude_desktop_config.json
{
  "mcpServers": {
    "personaldatahub": {
      "command": "npx",
      "args": ["pdh", "mcp"],
      "env": {}
    }
  }
}
```

The `npx pdh mcp` command starts a stdio-based MCP server that proxies to the running PersonalDataHub HTTP server on localhost. No API key or credentials needed — just the URL.

### Tool registration

The MCP server dynamically registers tools based on which sources are connected:
- Gmail connected → `read_emails`, `draft_email`, `send_email`, `reply_to_email`
- GitHub connected → `search_github_issues`, `search_github_prs`
- Source disconnected → tools for that source are not registered

This means agents only see tools for sources the owner has actually set up.

---

## API design: why POST for reads

The agent API uses `POST /app/v1/pull` for read operations, even though reads are semantically GET. This is a deliberate choice:

1. **The `purpose` field is free-text.** Every request includes a purpose string like `"Checking inbox for urgent emails from the finance team about the Q4 budget review"`. URL-encoding this in a query string is awkward and hits practical length limits.

2. **The `query` field contains source-native syntax.** Gmail queries like `is:unread from:alice newer_than:7d subject:"Q4 report"` have special characters that are painful to URL-encode.

3. **Agents never see the HTTP method.** With MCP as the primary interface, agents call `read_emails({ query: "is:unread", purpose: "..." })`. The underlying HTTP call is internal plumbing between the MCP server and the PersonalDataHub server. Whether it's GET or POST doesn't affect the agent experience or API discoverability.

Using POST for search/read endpoints is a well-established pattern (Elasticsearch, GitHub GraphQL API). The semantic purity of GET is not worth the practical friction for a localhost API whose primary consumer is an MCP proxy.

---

## Data flow

### Agent reads emails

```
Agent calls MCP tool: read_emails({ query: "is:unread", purpose: "Check inbox" })
  → MCP server translates to POST /app/v1/pull { source: "gmail", query: "is:unread", purpose: "..." }
  → PersonalDataHub fetches live from Gmail API using owner's OAuth token
  → Quick filters applied (time boundary, label filters, field redaction)
  → Filtered rows returned to agent
  → Audit log entry created
```

### Agent proposes a draft

```
Agent calls MCP tool: draft_email({ to: "alice@co.com", subject: "Re: Q4", body: "...", purpose: "Reply to Q4 thread" })
  → MCP server translates to POST /app/v1/propose { source: "gmail", action_type: "draft_email", ... }
  → Action inserted into staging table with status "pending"
  → Audit log entry created
  → Agent receives: { ok: true, status: "pending_review" }

Owner opens GUI (authenticated session):
  → Sees pending draft in staging queue
  → Reviews to/subject/body
  → Clicks Approve or Reject
  → If approved: PersonalDataHub sends via Gmail API, status → "committed"
  → If rejected: status → "rejected"
```

---

## Database changes

### Removed tables
- `api_keys` — no longer needed (agents don't authenticate)

### New tables

```sql
CREATE TABLE IF NOT EXISTS owner_auth (
  id TEXT PRIMARY KEY DEFAULT 'owner',
  password_hash TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at TEXT NOT NULL
);
```

### Unchanged tables
- `manifests` — kept for future use
- `staging` — action staging queue
- `audit_log` — append-only audit trail
- `oauth_tokens` — encrypted OAuth token storage
- `filters` — quick filter rules
- `github_repos` — GitHub repo access configuration

---

## CLI changes

```
npx pdh init [app-name]    Bootstrap installation (now prompts for password)
npx pdh start              Start server as personaldatahub user
npx pdh stop               Stop the server
npx pdh status             Check server status
npx pdh login              Print a one-time login URL (fallback for password reset)
npx pdh mcp                Start MCP stdio server (for agent integration)
npx pdh reset              Remove all generated files
```

### Removed commands
- `npx pdh demo-load` / `demo-unload` — demo data removed in cache cleanup

---

## Security model

### Assets

The following assets are what PersonalDataHub protects:

| Asset | Where stored | Compromise impact |
|-------|-------------|-------------------|
| **OAuth refresh tokens** | `pdh.db` (`oauth_tokens` table) | Attacker can call Gmail/GitHub API as the owner — read all emails, send emails, access repos. Highest-impact asset. |
| **Email/issue content** | Transient (fetched live, not stored) | Sensitive personal data exposed. Impact depends on what filters allow through. |
| **Quick filter configuration** | `pdh.db` (`filters` table) | Attacker can weaken filters to expose more data to agents. |
| **Staging queue approval** | `pdh.db` (`staging` table) | Attacker can approve pending actions, sending emails on the owner's behalf. |
| **Audit log** | `pdh.db` (`audit_log` table) | Attacker can read who accessed what. Integrity loss if attacker can write to DB. |
| **Owner password hash** | `pdh.db` (`owner_auth` table) | Attacker can brute-force the password offline. |

### Threat actors

#### 1. Agent running as main user (normal operation)

This is the expected operating mode. Agents run under the owner's main OS account and access PersonalDataHub via localhost HTTP.

| Attack | Outcome | Mitigation |
|--------|---------|-----------|
| Read filtered email data via `POST /pull` | **Allowed.** Agent sees data the owner intentionally exposed through quick filters. | Owner configures filters to restrict fields, redact sensitive patterns (SSNs, credit cards), limit time ranges. |
| Propose actions via `POST /propose` | **Allowed.** Action enters staging queue with status "pending". Does not execute. | Owner reviews and approves/rejects in the GUI. Agent cannot send emails without owner approval. |
| Approve its own staged actions | **Blocked.** Admin endpoints require a session cookie that only the owner's browser has. | HttpOnly session cookie, set only after password authentication in the `personaldatahub` user's browser. |
| Modify quick filters to see more data | **Blocked.** Filter management endpoints require session cookie. | Same as above. |
| Connect/disconnect OAuth sources | **Blocked.** OAuth endpoints require session cookie. | Same as above. |
| Read `pdh.db` directly to extract OAuth tokens | **Blocked.** DB file is owned by `personaldatahub` OS user with `0600` permissions. Agent process runs as main user. | OS file permission enforcement. Agent cannot read, write, or copy the file. |
| Keylog the owner's password on X11 | **Blocked.** The password is typed in the `personaldatahub` user's browser session, which has its own `~/.Xauthority`. | X11 does not allow cross-user keyboard capture. Agent's X11 session is separate from the `personaldatahub` user's session. |
| Exfiltrate data after receiving it | **Not blocked.** Once filtered data reaches the agent, PersonalDataHub cannot control what the agent does with it. | Minimize exposure through filter configuration. Network sandboxing of the agent process (firewall rules, container networking) is the owner's responsibility. |
| Call `POST /pull` in a tight loop, exhausting Gmail API quota | **Not blocked.** No rate limiting on the agent API. | Future enhancement: per-source rate limiting. Gmail's own API quota (10,000 queries/day) provides a backstop. |

#### 2. Agent escalates to root

If an agent gains root access (e.g., via a privilege escalation exploit, or the owner runs the agent with `sudo`), all application-level protections are bypassed.

| Attack | Outcome |
|--------|---------|
| Read `pdh.db` as root | **Succeeds.** Root can read any file regardless of ownership. Attacker gets OAuth refresh tokens, password hash, all DB contents. |
| Approve staged actions by writing to DB | **Succeeds.** Root can modify the SQLite database directly, changing staging status from "pending" to "approved". |
| Impersonate the `personaldatahub` user | **Succeeds.** Root can `su personaldatahub` without a password, access the browser session, or modify server config. |
| Install a persistent backdoor | **Succeeds.** Root can modify the PersonalDataHub server code, add a cron job, or install a keylogger. |

**Root access is a total compromise.** PersonalDataHub cannot defend against root. Mitigations are outside the application:
- Never run agents with `sudo` or as root
- Use containers or VMs to isolate agent runtimes from the host
- On Linux, use AppArmor/SELinux profiles to limit what agents can do even under the main user
- Monitor for privilege escalation attempts

#### 3. External attacker with root access

An external attacker who gains root access to the machine (e.g., via an unpatched vulnerability, phishing, physical access) has the same capabilities as scenario 2, plus:

| Attack | Outcome |
|--------|---------|
| All of scenario 2 | **Succeeds.** Same as agent-with-root. |
| Persist access across reboots | **Succeeds.** Can install systemd services, cron jobs, SSH keys, etc. |
| Exfiltrate OAuth tokens to external server | **Succeeds.** Can call Gmail/GitHub API from any machine using the stolen refresh token. |
| Intercept all future data flowing through PersonalDataHub | **Succeeds.** Can modify the server binary or inject a proxy. |

**This is the highest-impact scenario.** PersonalDataHub's security is bounded by host-level security. Mitigations:
- Disk encryption (protects against physical access when machine is off)
- OS access controls and timely patching
- Monitoring and alerting for unauthorized access
- OAuth token rotation and short-lived access tokens (limits window of stolen token usefulness)
- Gmail/GitHub security alerts for suspicious API access patterns

#### 4. Accidental network exposure

If the owner accidentally exposes PersonalDataHub to the network (e.g., via `ngrok`, Docker port mapping, firewall misconfiguration, or binding to `0.0.0.0` instead of `127.0.0.1`), remote attackers can reach the server.

| Attack | Outcome | Mitigation |
|--------|---------|-----------|
| Call `POST /pull` remotely to read filtered data | **Succeeds.** Agent API has no auth — any network client can read filtered emails/issues. | Quick filters limit what's visible, but anything agents can see, the remote attacker can see too. |
| Call `POST /propose` to stage malicious actions | **Succeeds.** Attacker can flood the staging queue with bogus proposals. | Actions still require owner approval. Attacker cannot execute them. |
| Access admin GUI to approve actions or change filters | **Blocked.** Admin endpoints require session cookie, which requires password authentication. | Session cookie cannot be obtained without the password. |
| Brute-force the login password remotely | **Partially blocked.** Login endpoint is accessible. Bcrypt slows brute-force but doesn't prevent it. | Future enhancement: rate limiting on login attempts, account lockout after failed attempts. |

**PersonalDataHub is designed for localhost only.** The server binds to `127.0.0.1` by default. Exposing it to the network is a misconfiguration, but the auth model provides partial defense:
- Admin operations are still protected by the session cookie
- Agent API data is limited by quick filters
- Actions cannot execute without owner approval
- The main risk is unauthorized reading of filtered data

### Design assumptions

- **Single-owner.** PersonalDataHub is a personal server for one owner. There is no multi-user or multi-tenant model. Multiple agents can use it, but they all see the same filtered view.
- **Localhost only.** The server is intended to run on the owner's local machine and bind to `127.0.0.1`. Network deployment is not supported.
- **OS user separation is the primary isolation boundary.** The `personaldatahub` OS user protects the DB and OAuth tokens from agent processes. This is stronger than application-level auth because it's enforced by the kernel.
- **Root is out of scope.** No application can defend against root access. The owner is responsible for not granting root to agents and for securing their machine against external compromise.

---

## Implementation plan

### Phase 1: Remove API keys + add owner auth
1. Drop `api_keys` table from schema
2. Remove auth middleware from `/app/v1/*` endpoints
3. Add `owner_auth` and `sessions` tables
4. Add login page to GUI
5. Add session cookie middleware to `/api/*` admin endpoints
6. Update `npx pdh init` to prompt for password
7. Remove `~/.pdh/credentials.json` apiKey field (keep hubUrl and hubDir)
8. Update tests

### Phase 2: MCP server
1. Add `npx pdh mcp` command that starts stdio MCP server
2. Implement MCP tool handlers that proxy to HTTP endpoints
3. Dynamic tool registration based on connected sources
4. Update OpenClaw plugin to use MCP (or deprecate in favor of direct MCP)

### Phase 3: Source-specific tools
1. Replace `personal_data_pull` / `personal_data_propose` with source-specific tools
2. Update system prompt for agents
3. Update SKILL.md documentation

### Phase 4: Process isolation (personaldatahub user)
1. `npx pdh init` creates `personaldatahub` system user (requires sudo)
2. `npx pdh start` launches server as personaldatahub user via `su` or systemd
3. DB and config files owned by personaldatahub user with 0600 permissions
4. Document setup for Linux (systemd service) and macOS (launchd)

Phases 1-3 can be implemented without process isolation. Phase 4 hardens the deployment but requires OS-level changes that vary by platform.
