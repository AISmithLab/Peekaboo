# Setup

How to install and run PersonalDataHub.

PersonalDataHub uses **two OS users** for security isolation:

- **`personaldatahub` user** — runs the server, owns the database and OAuth tokens. You switch to this user to manage sources and approve actions via the GUI.
- **Your main user** — runs AI agents (Claude Code, Cursor, etc.). Agents talk to the server over localhost HTTP. They cannot read the database or OAuth tokens directly.

This separation means a compromised agent cannot extract your Gmail/GitHub OAuth tokens from disk — the files are owned by a different OS user with `0600` permissions.

## Prerequisites

- **Node.js >= 22** — check with `node --version`
- **pnpm** — install with `npm install -g pnpm`
- **sudo access** — needed to create the `personaldatahub` OS user

## Step 1: Create the `personaldatahub` OS User

### macOS

```bash
# Create a hidden system user (no home directory login shell)
sudo sysadminctl -addUser personaldatahub -shell /bin/zsh -password -
# Create its home directory
sudo mkdir -p /Users/personaldatahub
sudo chown personaldatahub:staff /Users/personaldatahub
```

### Linux

```bash
sudo useradd -r -m -s /bin/bash personaldatahub
```

## Step 2: Clone and Bootstrap as `personaldatahub`

Switch to the `personaldatahub` user and install:

```bash
sudo -u personaldatahub -i
cd ~
git clone https://github.com/AISmithLab/PersonalDataHub.git
cd PersonalDataHub
pnpm install && pnpm build
npx pdh init
```

`npx pdh init` creates:

| File | Purpose |
|------|---------|
| `.env` | Master encryption key for OAuth tokens |
| `hub-config.yaml` | Server config with OAuth credentials and port |
| `pdh.db` | SQLite database (owned by `personaldatahub`, mode `0600`) |
| `~personaldatahub/.pdh/config.json` | Hub URL and directory |

It prints an **owner password** — save it. You need it to log into the GUI.

## Step 3: Start the Server

Still as the `personaldatahub` user:

```bash
npx pdh start
```

Verify it's running:

```bash
npx pdh status
# or: curl http://localhost:3000/health
```

The server does **not** auto-start on reboot by default. You can either run `npx pdh start` after each restart, or install a system service (see below).

You can now exit the `personaldatahub` shell:

```bash
exit
```

### Optional: Auto-start on reboot

To have PersonalDataHub start automatically on boot, install a system service. Run this as your **main user** (not `personaldatahub`), since it requires sudo:

```bash
sudo npx pdh install-service
```

This creates a systemd service (Linux) or launchd daemon (macOS) that runs the server as the `personaldatahub` user.

**Manage the service:**

```bash
# Linux
sudo systemctl status personaldatahub    # check status
sudo systemctl restart personaldatahub   # restart
journalctl -u personaldatahub -f         # view logs

# macOS
sudo launchctl list | grep personaldatahub   # check status
```

**Remove the service:**

```bash
sudo npx pdh uninstall-service
```

## Step 4: Connect Data Sources

You need to connect OAuth sources (Gmail, GitHub) from the `personaldatahub` user's browser session so that the agent running as your main user cannot intercept the keyboard or session cookie.

### macOS

Switch to the `personaldatahub` user's desktop session:

```bash
# Open a login window for the personaldatahub user
# (or use Fast User Switching in System Preferences > Login Window)
sudo -u personaldatahub open -a Safari http://localhost:3000
```

### Linux

Switch to the `personaldatahub` user's desktop session (e.g., via a separate TTY or display manager), then open `http://localhost:3000` in a browser.

### In the GUI

Log in with the owner password from Step 2, then:

**Gmail:**
1. Click the **Gmail** tab, then **Connect Gmail**
2. Sign in with your Google account and grant PersonalDataHub access
3. Configure quick filters to control what agents can see

**GitHub:**
1. Click the **GitHub** tab, then **Connect GitHub**
2. Authorize PersonalDataHub to access your GitHub account
3. Select which repos the agent can access

To use your own OAuth credentials instead of the defaults, see [OAUTH-SETUP.md](./OAUTH-SETUP.md).

## Step 5: Connect Your Agent (Main User)

Back as your **main user**, set up the MCP config so `~/.pdh/config.json` points to the running server. Create it if it doesn't exist:

```bash
mkdir -p ~/.pdh
echo '{"hubUrl":"http://localhost:3000","hubDir":"/Users/personaldatahub/PersonalDataHub"}' > ~/.pdh/config.json
```

Then connect your agent using one of the options below.

### Option A: MCP (recommended)

Works with Claude Code, Cursor, Windsurf, and any MCP-compatible agent.

**Claude Code** — add to `.claude/settings.json`:

```json
{
  "mcpServers": {
    "personaldatahub": {
      "command": "npx",
      "args": ["pdh", "mcp"]
    }
  }
}
```

**Cursor / Windsurf** — add the same `command` and `args` in MCP settings.

The MCP server reads `~/.pdh/config.json`, verifies the server is running, and registers tools for connected sources only. Disconnect a source and its tools disappear.

You can test it standalone:

```bash
npx pdh mcp
# Prints registered tools to stderr, then listens on stdio
```

### Option B: OpenClaw

If your agent uses the OpenClaw framework, PersonalDataHub is available as an OpenClaw skill (`@openclaw/personaldatahub`). The skill auto-discovers the running server via `~/.pdh/config.json` and registers `pull` and `propose` tools.

See [`packages/personaldatahub/SKILL.md`](../packages/personaldatahub/SKILL.md) for tool details and configuration.

## Step 6: Verify

Ask your agent:

> "Check my recent emails"

Verify in the GUI (as the `personaldatahub` user):
- **Gmail tab** → Recent Activity shows the pull request
- **Settings tab** → Audit Log shows every data access with timestamps and purpose strings

---

## Managing the Server

All server management commands must be run as the `personaldatahub` user:

```bash
sudo -u personaldatahub -i
cd ~/PersonalDataHub

npx pdh status   # Check if the server is running
npx pdh stop     # Stop the background server
npx pdh start    # Start the server
npx pdh reset    # Remove all generated files and start fresh
```

To approve staged actions or change filters, switch to the `personaldatahub` user's browser session and open `http://localhost:3000`.

---

## Direct API Usage

Any localhost process can call the agent API (no auth required). The GUI admin endpoints require the owner's session cookie.

**Pull data:**

```bash
curl -X POST http://localhost:3000/app/v1/pull \
  -H "Content-Type: application/json" \
  -d '{"source": "gmail", "purpose": "Find recent emails"}'
```

**Propose an action:**

```bash
curl -X POST http://localhost:3000/app/v1/propose \
  -H "Content-Type: application/json" \
  -d '{
    "source": "gmail",
    "action_type": "draft_email",
    "action_data": {"to": "alice@co.com", "subject": "Hi", "body": "Hello"},
    "purpose": "Draft greeting"
  }'
```

**Discover connected sources:**

```bash
curl http://localhost:3000/app/v1/sources
```

---

## Troubleshooting

**MCP server says "No PersonalDataHub config found"**
- Create `~/.pdh/config.json` in your main user's home directory (see Step 5)

**MCP server says "not reachable"**
- The server runs as the `personaldatahub` user: `sudo -u personaldatahub npx pdh status`
- If not running: `sudo -u personaldatahub -i`, then `cd ~/PersonalDataHub && npx pdh start`

**No tools appear in MCP**
- Connect at least one source via OAuth in the GUI (as `personaldatahub` user)
- Only sources with active OAuth tokens get tools registered

**`npx pdh init` fails with ".env already exists"**
- Already initialized. Start the server: `npx pdh start`
- To re-initialize: `npx pdh reset` then `npx pdh init`

**Permission denied accessing pdh.db**
- The database is owned by the `personaldatahub` user. Run server commands as that user.
- Agents should never access the DB directly — they use the HTTP API.

**OAuth redirect fails**
- Make sure the redirect URI in your OAuth app settings matches `http://localhost:3000/oauth/<source>/callback`
