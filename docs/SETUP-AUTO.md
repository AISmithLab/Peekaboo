# Auto Setup (OpenClaw)

How to set up Peekaboo automatically through ClawHub or the OpenClaw skill.

## Overview

Peekaboo can be installed as an OpenClaw skill through [ClawHub](https://theoperatorvault.io/clawhub-guide), the community marketplace for OpenClaw skills. The install hook bootstraps the Peekaboo hub, and the skill auto-discovers it at runtime.

## Option A: Install via ClawHub (Recommended)

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

If you prefer to install directly from the repository instead of ClawHub.

### Step 1: Clone and Bootstrap

```bash
git clone https://github.com/AISmithLab/Peekaboo.git
cd peekaboo
pnpm install && pnpm build
npx peekaboo init
```

This generates a master secret, config, database, API key, and saves credentials to `~/.peekaboo/credentials.json`.

You can pass a custom app name:

```bash
npx peekaboo init "My AI Agent"
```

### Step 2: Start the Server

```bash
npx peekaboo start
```

This starts the server in the background. Verify it's running:

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

The skill is in `packages/personal-data-hub/`. It reads credentials automatically from `~/.peekaboo/credentials.json` — no manual configuration needed.

If the credentials file doesn't exist, the skill falls back to auto-discovery (probes `localhost:3000` and `localhost:7007`).

### Step 4: Connect Data Sources

Open `http://localhost:3000` in your browser. Connect Gmail and GitHub via OAuth. See the [Manual Setup Guide](SETUP-MANUAL.md) for detailed source configuration.

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

## Troubleshooting

**Extension says "Missing hubUrl or apiKey"**
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
