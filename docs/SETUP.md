# Setup

How to install and run Peekaboo.

## Option A: Install via ClawHub (Recommended)

Install Peekaboo as an [OpenClaw](https://theoperatorvault.io) skill through [ClawHub](https://theoperatorvault.io/clawhub-guide), the community marketplace for OpenClaw skills.

### Prerequisites

- **Node.js >= 22** — check with `node --version`
- **pnpm** — install with `npm install -g pnpm`
- **OpenClaw** installed and running
- **ClawHub CLI** — install with `npm i -g clawhub`

### Step 1: Install the Skill

```bash
clawhub install personaldatahub
```

This downloads the skill and runs the install hook, which:
1. Installs dependencies (`pnpm install`)
2. Builds the project (`pnpm build`)
3. Runs `npx peekaboo init "OpenClaw Agent"` — generates a master secret, config, database, and API key
4. Saves credentials to `~/.peekaboo/credentials.json` (auto-read by agents)
5. Starts the server in the background (`npx peekaboo start`)

No manual configuration needed — agents read credentials automatically.

### Step 2: Connect Data Sources

Open `http://localhost:3000` in your browser:

1. **Gmail** — Click "Connect Gmail" to start OAuth. Configure access boundaries (date range, labels, field access, redaction rules).
2. **GitHub** — Click "Connect GitHub" to start OAuth. Select which repos the agent can access and at what permission level.

### Step 3: Verify

Ask your AI agent:

> "Check my recent emails"

The agent uses `personal_data_pull` through Peekaboo. Verify in the GUI:
- **Gmail tab** → Recent Activity shows the pull request
- **Settings tab** → Audit Log shows every data access with timestamps and purpose strings

### Updating

```bash
clawhub update personaldatahub
```

---

## Option B: Install from Source

Install directly from the repository. Works with or without OpenClaw.

### Prerequisites

- **Node.js >= 22** — check with `node --version`
- **pnpm** — install with `npm install -g pnpm`

### Step 1: Clone and Bootstrap

```bash
git clone https://github.com/AISmithLab/Peekaboo.git
cd peekaboo
pnpm install && pnpm build
npx peekaboo init
```

This generates a master secret, config, database, API key, and saves credentials to `~/.peekaboo/credentials.json`.



### Step 2: Start the Server

```bash
npx peekaboo start
```

This starts the server in the background. The server does **not** auto-start on reboot — run `npx peekaboo start` again after restarting your machine.

Verify it's running:

```bash
npx peekaboo status
# or: curl http://localhost:3000/health
```

Other server commands:

```bash
npx peekaboo stop     # Stop the background server
npx peekaboo status   # Check if the server is running
```

### Step 3: Install the Skill in OpenClaw

The skill is in `packages/personal-data-hub/`. OpenClaw discovers skills from directories containing a `SKILL.md` with YAML frontmatter. To register it, pick one option:

**Option 1: Symlink into the global skills directory (Recommended)**

```bash
mkdir -p ~/.openclaw/skills
ln -s /absolute/path/to/peekaboo/packages/personal-data-hub ~/.openclaw/skills/personal-data-hub
```

Replace `/absolute/path/to/peekaboo` with the actual path to your cloned repo. This makes the skill available in all OpenClaw sessions.

**Option 2: Add as an extra skills directory**

Add the path to `skills.load.extraDirs` in `~/.openclaw/openclaw.json`:

```json
{
  "skills": {
    "load": {
      "extraDirs": ["/absolute/path/to/peekaboo/packages/personal-data-hub"]
    }
  }
}
```

Start a new OpenClaw session for it to discover the skill. Run `openclaw tui` to launch a new session, then type `list skills` to verify the skill is installed.

The skill reads credentials automatically from `~/.peekaboo/credentials.json` — no manual configuration needed. If the credentials file doesn't exist, the skill falls back to auto-discovery (probes `localhost:3000` and `localhost:7007`).

**Not using OpenClaw?** Skip this step — you can use the API directly. See [Direct API Usage](#direct-api-usage) below.

### Step 4: Connect Data Sources

Open `http://localhost:3000` in your browser. No OAuth credentials needed — Peekaboo ships with default credentials and uses PKCE for secure authorization. Just click Connect.

#### Connecting Gmail

1. Click the **Gmail** tab, then **Connect Gmail**
2. Sign in with your Google account and grant Peekaboo access
3. Configure your access boundary:
   - **Time boundary** — e.g., "only emails after 2026-01-01"
   - **Label filters** — which labels are accessible (inbox, starred, etc.)
   - **Field access** — strip sender info, strip body, etc.
   - **Redaction** — redact SSNs, credit card numbers, phone numbers
   - **Outbound actions** — allow/disallow draft proposals

#### Connecting GitHub

1. Click the **GitHub** tab, then **Connect GitHub**
2. Authorize Peekaboo to access your GitHub account
3. Select which repos the agent can access and set permission levels per repo

To set up the agent's GitHub account:
1. Create a separate GitHub account for your AI agent (e.g., `@alice-ai-agent`)
2. In the Peekaboo GUI, enter the agent's GitHub username
3. Peekaboo uses your (the owner's) OAuth token to add the agent as a collaborator on the repos you select
4. The agent uses its own credentials (fine-grained PAT) to interact with GitHub directly

**Advanced:** To use your own OAuth app instead of the defaults, see [OAUTH-SETUP.md](./OAUTH-SETUP.md).

### Step 5: Verify

Same as Option A Step 3 — ask your agent to check recent emails and verify activity in the GUI.

---

## Direct API Usage

Any HTTP client can use Peekaboo's two endpoints. Both require an API key (`Authorization: Bearer pk_xxx`). Find your API key in `~/.peekaboo/credentials.json` or generate one in the GUI under **Settings > Generate API Key**.

### Pull Data

```bash
curl -X POST http://localhost:3000/app/v1/pull \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer pk_your_key_here" \
  -d '{"source": "gmail", "purpose": "Find recent emails"}'
```

### Propose an Action

```bash
curl -X POST http://localhost:3000/app/v1/propose \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer pk_your_key_here" \
  -d '{
    "source": "gmail",
    "action_type": "draft_email",
    "action_data": {"to": "alice@co.com", "subject": "Hi", "body": "Hello"},
    "purpose": "Draft greeting"
  }'
```

Actions are staged for owner review — not executed until approved via the GUI.

---

## Access Policy Presets

The GUI offers preset access policies for Gmail. Start with a preset and customize it:

| Preset | What the agent sees |
|---|---|
| Read-only, recent emails | title, body, labels, timestamp — SSNs redacted |
| Metadata only | title, labels, timestamp — no body or sender info |
| Full access with redaction | All fields — sensitive patterns redacted, body truncated to 5000 chars |
| Email drafting | Can propose draft emails for owner review |

---

## How Auto-Setup Works

When the skill starts, it resolves config in this order:

1. **Plugin config** — `hubUrl` + `apiKey` passed directly
2. **Environment variables** — `PEEKABOO_HUB_URL` + `PEEKABOO_API_KEY`
3. **Credentials file** — reads `~/.peekaboo/credentials.json` (written by `npx peekaboo init`)
4. **Auto-discovery** — probes `localhost:3000`, `localhost:7007`, `127.0.0.1:3000`, `127.0.0.1:7007` for a running hub, then creates an API key

If no config is found at any step, the skill logs setup instructions and gracefully degrades (no tools registered).

## What `npx peekaboo init` Does

The init command creates:

| File | Purpose |
|------|---------|
| `.env` | Contains `PEEKABOO_SECRET=<random 32-byte base64>` — the master encryption key for cached data |
| `hub-config.yaml` | Minimal config with `sources: {}` and `port: 3000` — sources are configured via the GUI |
| `peekaboo.db` | SQLite database with all tables initialized (api_keys, manifests, cached_data, staging, audit_log) |
| `~/.peekaboo/credentials.json` | Credentials (`hubUrl`, `apiKey`, `hubDir`) — auto-read by agents at startup |

It also creates an API key and saves it to the credentials file. You can manage API keys in the GUI.

## Publishing to ClawHub

To publish or update the skill on ClawHub:

```bash
clawhub publish packages/personal-data-hub \
  --slug personaldatahub \
  --name "PersonalDataHub" \
  --version 0.1.0 \
  --tags latest
```

## Contributing

Want to contribute to Peekaboo? See [DEVELOPMENT.md](./DEVELOPMENT.md) for the project structure, tech stack, how the pipeline works, how to add connectors and operators, and how to run the test suite.

## Troubleshooting

**Skill says "Missing hubUrl or apiKey"**
- Make sure Peekaboo is running: `npx peekaboo status`
- If not running, start it: `npx peekaboo start`
- Check credentials exist: `cat ~/.peekaboo/credentials.json`
- If no credentials, re-run: `npx peekaboo init`

**`npx peekaboo init` fails with ".env already exists"**
- You've already initialized. Just start the server: `npx peekaboo start`
- To re-initialize, delete `.env`, `hub-config.yaml`, and `peekaboo.db` first

**Server won't start**
- Check if already running: `npx peekaboo status`
- Stop it first: `npx peekaboo stop`, then start again

**Port already in use**
- Edit `hub-config.yaml` and change `port: 3000` to a different port
- Update `~/.peekaboo/credentials.json` to match the new URL

**OAuth redirect fails**
- Make sure the redirect URI in your Google Cloud / GitHub OAuth app settings matches `http://localhost:3000/oauth/<source>/callback` (e.g., `http://localhost:3000/oauth/gmail/callback`)
