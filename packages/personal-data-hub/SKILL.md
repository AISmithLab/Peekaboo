---
name: PersonalDataHub
description: Pull personal data (emails, issues) and propose outbound actions (drafts, replies) through the Peekaboo access control gateway. Data is filtered, redacted, and shaped by the owner's policy before reaching the agent.
version: 0.1.0
skillKey: personaldatahub
emoji: 🔐
homepage: https://github.com/AISmithLab/Peekaboo
os: darwin, linux, win32
install: cd ../../ && pnpm install && pnpm build && npx peekaboo init "OpenClaw Agent" && npx peekaboo start
metadata: {}
always: false
---

# PersonalDataHub

Access personal data from Gmail, GitHub, and other sources through the Peekaboo access control gateway. The data owner controls what the agent can see, which fields are visible, what gets redacted, and which actions are allowed.

## Tools

### personal_data_pull

Pull data from a source. Data is filtered and redacted according to the owner's access control policy.

**Parameters:**
- `source` (required) — The data source (e.g., `"gmail"`, `"github"`)
- `purpose` (required) — Why this data is needed (logged for audit)
- `type` (optional) — Data type (e.g., `"email"`, `"issue"`)
- `query` (optional) — Search query in source-native syntax (e.g., `"is:unread from:alice"`)
- `limit` (optional) — Maximum number of results

**Example:**
```
Pull my recent unread emails about the Q4 report.
```

### personal_data_propose

Propose an outbound action (e.g., draft email). The action is staged for the data owner to review and approve — it does NOT execute until approved.

**Parameters:**
- `source` (required) — The source service (e.g., `"gmail"`)
- `action_type` (required) — Action type (e.g., `"draft_email"`, `"send_email"`, `"reply_email"`)
- `to` (required) — Recipient email address
- `subject` (required) — Email subject
- `body` (required) — Email body
- `purpose` (required) — Why this action is being proposed (logged for audit)
- `in_reply_to` (optional) — Message ID for threading

**Example:**
```
Draft a reply to Alice's Q4 report email thanking her for the numbers.
```

## Setup

The install hook bootstraps Peekaboo automatically:
1. Installs dependencies, builds the project, initializes the database
2. Creates an API key and saves it to `~/.peekaboo/credentials.json`
3. Starts the server in the background

After installation, open `http://localhost:3000` to connect Gmail/GitHub via OAuth.

The extension reads credentials automatically from `~/.peekaboo/credentials.json` — no manual configuration needed.

## Query Syntax (Gmail)

- `is:unread` — unread emails
- `from:alice` — emails from Alice
- `newer_than:7d` — emails from the last 7 days
- `subject:report` — emails with "report" in subject
- Combine: `is:unread from:alice newer_than:7d`

## Important Notes

- **Data is filtered**: The owner controls which fields you see. Some fields may be missing or redacted.
- **Actions require approval**: All outbound actions (emails, drafts) go to a staging queue. The owner must approve before execution.
- **Everything is audited**: Every pull and propose is logged with your purpose string.
