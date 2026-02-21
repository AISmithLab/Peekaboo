# Auto Setup (OpenClaw)

How to set up Peekaboo automatically through the OpenClaw extension.

## Overview

The PersonalDataHub extension can auto-discover a running Peekaboo hub and configure itself. This guide walks you through bootstrapping Peekaboo and connecting the extension — the fastest path to getting an AI agent working with your personal data.

## Prerequisites

- **Node.js >= 22** — check with `node --version`
- **pnpm** — install with `npm install -g pnpm` if you don't have it
- **OpenClaw** installed and running

## Quick Setup

### Step 1: Bootstrap Peekaboo

```bash
git clone https://github.com/AISmithLab/Peekaboo.git
cd peekaboo
pnpm install && pnpm build
```

Run the init command to generate a master secret, config file, database, and API key:

```bash
npx peekaboo init
```

Output:

```
  Peekaboo initialized successfully!

  .env created            /path/to/peekaboo/.env
  hub-config.yaml created  /path/to/peekaboo/hub-config.yaml
  Database created         /path/to/peekaboo/peekaboo.db

  API Key (save this — shown only once):
    pk_abc123def456...

  Next steps:
    1. Start the server:  node dist/index.js
    2. Open the GUI:      http://localhost:3000
    3. Connect sources and configure access policies
```

Save the API key — you'll need it if you want to configure the extension manually.

You can also pass a custom app name:

```bash
npx peekaboo init "My AI Agent"
```

### Step 2: Start the Server

```bash
node dist/index.js
```

The server starts at `http://localhost:3000`. Verify it's running:

```bash
curl http://localhost:3000/health
# {"ok":true,"version":"0.1.0"}
```

### Step 3: Install the Extension in OpenClaw

Install the PersonalDataHub extension from `packages/personal-data-hub/`.

**Option A: Auto-setup (recommended)**

If the Peekaboo hub is running on `localhost:3000` or `localhost:7007`, the extension auto-discovers it and creates an API key. No configuration needed — just install and go.

The extension will log:

```
PersonalDataHub: Discovered hub at http://localhost:3000
PersonalDataHub: Auto-created API key. Save this for your config: pk_...
PersonalDataHub: Registering tools (hub: http://localhost:3000)
```

**Option B: Manual configuration**

If the hub is on a non-default port, or you want to use a specific API key, configure the extension:

```json
{
  "hubUrl": "http://localhost:3000",
  "apiKey": "pk_your_key_from_step_1"
}
```

### Step 4: Connect Data Sources

Open `http://localhost:3000` in your browser. The GUI has tabs for each source.

1. **Gmail** — Click "Connect Gmail" to start OAuth. Configure access boundaries (date range, labels, field access, redaction rules).
2. **GitHub** — Click "Connect GitHub" to start OAuth. Select which repos the agent can access and at what permission level.

See the [Manual Setup Guide](SETUP.md) for detailed source configuration instructions.

### Step 5: Verify

Ask your AI agent to pull data:

> "Check my recent emails"

The agent uses `personal_data_pull` through Peekaboo. You can verify in the GUI:

- **Gmail tab** → Recent Activity shows the pull request
- **Settings tab** → Audit Log shows every data access with timestamps and purpose strings

## How Auto-Setup Works

When the extension starts without a complete config (`hubUrl` + `apiKey`):

1. **Discovery** — probes `localhost:3000`, `localhost:7007`, `127.0.0.1:3000`, `127.0.0.1:7007` for a running hub by calling `GET /health`
2. **API key creation** — if a hub is found, calls `POST /api/keys` to create an API key for "OpenClaw Agent"
3. **Registration** — uses the discovered URL and created key to register the `personal_data_pull` and `personal_data_propose` tools

If no hub is found, the extension logs setup instructions and gracefully degrades (no tools registered).

## What `npx peekaboo init` Does

The init command creates three files:

| File | Purpose |
|------|---------|
| `.env` | Contains `PEEKABOO_SECRET=<random 32-byte base64>` — the master encryption key for cached data |
| `hub-config.yaml` | Minimal config with `sources: {}` and `port: 3000` — sources are configured via the GUI |
| `peekaboo.db` | SQLite database with all tables initialized (api_keys, manifests, cached_data, staging, audit_log) |

It also creates one API key and prints it to the console.

## Troubleshooting

**Extension says "Missing hubUrl or apiKey. Auto-setup could not find a running hub."**
- Make sure Peekaboo is running: `curl http://localhost:3000/health`
- If not running, start it: `node dist/index.js`
- If running on a non-default port, configure the extension manually with `hubUrl`

**`npx peekaboo init` fails with ".env already exists"**
- You've already initialized. Just start the server: `node dist/index.js`
- To re-initialize, delete `.env`, `hub-config.yaml`, and `peekaboo.db` first

**Auto-setup creates a new API key each time the extension restarts**
- This happens when the extension config isn't persisted between restarts
- Configure the extension with a fixed `apiKey` to prevent this
- You can revoke unused keys in the GUI (Settings tab → API Keys → Revoke)

**Port already in use**
- Edit `hub-config.yaml` and change `port: 3000` to a different port
- Then configure the extension with the matching `hubUrl`
