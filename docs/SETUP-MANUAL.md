# Manual Setup

How to install and run Peekaboo in a new environment, step by step.

## Prerequisites

- **Node.js >= 22** — check with `node --version`
- **pnpm** — install with `npm install -g pnpm` if you don't have it

## Installation

```bash
git clone https://github.com/AISmithLab/Peekaboo.git
cd peekaboo

# Install dependencies
pnpm install

# Build
pnpm build

# Verify everything works
pnpm test
```

## Step 1: Generate a Master Secret

The master secret is used to encrypt cached email data at rest (AES-256-GCM). Generate a strong random key:

```bash
# Option A: use openssl
openssl rand -base64 32
# Example output: K7xQj2mP9vR4nL8wF1hT6yA3bD5eG0iU+cXzW=

# Option B: use node
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
```

Save this value — you'll need it in the next step. If you lose it, any locally cached data encrypted with it becomes unrecoverable.

## Step 2: Set Environment Variables

Create a `.env` file in the project root (it's already in `.gitignore`):

```bash
# .env
PEEKABOO_SECRET=K7xQj2mP9vR4nL8wF1hT6yA3bD5eG0iU+cXzW=
```

Or export in your shell:

```bash
export PEEKABOO_SECRET=K7xQj2mP9vR4nL8wF1hT6yA3bD5eG0iU+cXzW=
```

The only required environment variable is `PEEKABOO_SECRET`. Source-specific credentials (Gmail, GitHub) are handled through OAuth in the GUI — you don't need to configure them manually.

## Step 3: Configure the Hub

Copy the example config:

```bash
cp hub-config.example.yaml hub-config.yaml
```

Edit `hub-config.yaml`:

```yaml
server:
  port: 7007
  host: "127.0.0.1"       # Binds to localhost only — not exposed to network

encryption:
  masterSecret: "${PEEKABOO_SECRET}"   # Resolved from environment variable
```

That's the minimum config. Source connections (Gmail, GitHub) are set up through the GUI after the server starts.

## Step 4: Start the Server

```bash
node dist/index.js
```

Or with the environment variable inline:

```bash
PEEKABOO_SECRET=your-secret-here node dist/index.js
```

The server starts at `http://localhost:7007`.

## Step 5: Connect Sources via the GUI

Open `http://localhost:7007/` in your browser. The GUI has tabs for each source.

### Connecting Gmail

1. Click the **Gmail** tab
2. Click **Connect Gmail**
3. You're redirected to Google's OAuth consent screen
4. Sign in with your Google account and grant Peekaboo access to your Gmail
5. Google redirects back to Peekaboo — your OAuth tokens (access + refresh) are saved automatically
6. Configure your access boundary:
   - **Time boundary** — e.g., "only emails after 2026-01-01"
   - **Label filters** — which labels are accessible (inbox, starred, etc.)
   - **Field access** — strip sender info, strip body, etc.
   - **Redaction** — redact SSNs, credit card numbers, phone numbers
   - **Outbound actions** — allow/disallow draft proposals

No environment variables needed for Gmail. The OAuth flow handles everything.

**Note:** To use OAuth, you need a Google Cloud project with the Gmail API enabled and OAuth credentials configured. See [Google's guide](https://developers.google.com/gmail/api/quickstart/nodejs) for creating OAuth credentials. Set the redirect URI to `http://localhost:7007/oauth/gmail/callback`.

### Connecting GitHub

1. Click the **GitHub** tab
2. Click **Connect GitHub**
3. You're redirected to GitHub's OAuth authorization screen
4. Authorize Peekaboo to access your GitHub account
5. GitHub redirects back — your OAuth token is saved automatically
6. Configure repo access:
   - Select which repos the agent can access
   - Set permission levels per repo (read-only, read/write issues, etc.)
   - Peekaboo uses the GitHub collaborator API to grant your agent account access

No PAT environment variables needed. The OAuth flow handles authentication. Peekaboo uses the OAuth token to manage collaborator access for your agent's separate GitHub account.

**Setting up the agent's GitHub account:**

1. Create a separate GitHub account for your AI agent (e.g., `@alice-ai-agent`)
2. In the Peekaboo GUI, enter the agent's GitHub username
3. Peekaboo uses your (the owner's) OAuth token to add `@alice-ai-agent` as a collaborator on the repos you select
4. The agent uses its own credentials (fine-grained PAT for `@alice-ai-agent`) to interact with GitHub directly

## Step 6: Generate an API Key

1. Click the **Settings** tab in the GUI
2. Click **Generate API Key**
3. Copy the key (e.g., `pk_abc123...`) — it's shown once and stored as a bcrypt hash
4. Give this key to your AI agent (e.g., configure it in OpenClaw)

Agents authenticate all API calls with:

```
Authorization: Bearer pk_xxx
```

## Step 7: Connect Your AI Agent

### OpenClaw Extension

If you're using OpenClaw, install the PersonalDataHub extension from `packages/personal-data-hub/`:

```json
{
  "hubUrl": "http://localhost:7007",
  "apiKey": "pk_your_key_here"
}
```

This registers two tools for the agent:
- `personal_data_pull` — read data from sources through Peekaboo
- `personal_data_propose` — propose outbound actions (drafts, replies) for owner review

### Direct API Usage

Any HTTP client can use the two endpoints:

```bash
# Pull data
curl -X POST http://localhost:7007/app/v1/pull \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer pk_your_key_here" \
  -d '{"source": "gmail", "purpose": "Find recent emails"}'

# Propose an action
curl -X POST http://localhost:7007/app/v1/propose \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer pk_your_key_here" \
  -d '{"source": "gmail", "action_type": "draft_email", "action_data": {"to": "alice@co.com", "subject": "Hi", "body": "Hello"}, "purpose": "Draft greeting"}'
```

## Access Policy Presets

The GUI offers preset access policies for Gmail. You can start with a preset and customize it:

| Preset | What the agent sees |
|---|---|
| Read-only, recent emails | title, body, labels, timestamp — SSNs redacted |
| Metadata only | title, labels, timestamp — no body or sender info |
| Full access with redaction | All fields — sensitive patterns redacted, body truncated to 5000 chars |
| Email drafting | Can propose draft emails for owner review |

## Optional: Local Caching

By default, Peekaboo fetches data on the fly from source APIs and never stores personal data locally. You can enable local caching per source for offline access or performance:

```yaml
sources:
  gmail:
    cache:
      enabled: true
      sync_interval: "30m"    # Refresh cache every 30 minutes
      ttl: "7d"               # Expire cached items after 7 days
      encrypt: true           # Encrypt at rest (default: true)
```

When caching is enabled, the `pull` operator reads from the local encrypted cache instead of hitting the Gmail API each time. A background sync keeps the cache fresh.

## Troubleshooting

**"No config file found"** — Make sure `hub-config.yaml` exists in the project root. Copy from `hub-config.example.yaml`.

**"PEEKABOO_SECRET not set"** — Set the `PEEKABOO_SECRET` environment variable. See Step 2.

**OAuth redirect fails** — Make sure the redirect URI in your Google Cloud / GitHub OAuth app settings matches `http://localhost:<port>/oauth/<source>/callback` (e.g., `http://localhost:7007/oauth/gmail/callback`).

**Port already in use** — Change `server.port` in `hub-config.yaml` to a different port.
