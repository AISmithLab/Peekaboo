# OpenClaw Installation Guide

This guide covers installing PersonalDataHub for use with **OpenClaw**. Because OpenClaw agents run with broader system access, this setup uses **OS-level user separation** to isolate OAuth tokens and the database from the agent process.

> For the simpler Claude Code / Cursor / Windsurf setup (no user separation required), see the main [README](../README.md).

---

## Prerequisites

- **Node.js** 22+
- **pnpm** (package manager)
- A **Gmail** and/or **GitHub** account to connect

---

## 1. Create a Dedicated OS User (one-time)

PersonalDataHub runs as a dedicated OS user (`personaldatahub`) so that agents cannot access your OAuth tokens or database directly.

### macOS

```bash
sudo sysadminctl -addUser personaldatahub -shell /bin/zsh -password -
sudo mkdir -p /Users/personaldatahub && sudo chown personaldatahub:staff /Users/personaldatahub
```

### Linux (Ubuntu)

```bash
sudo adduser --system --home /home/personaldatahub --shell /bin/bash personaldatahub
sudo usermod -aG sudo personaldatahub   # only if needed for install
```

> For full Linux details, see the [Setup Guide](SETUP.md).

---

## 2. Install and Start the Server

```bash
# Switch to the personaldatahub user
sudo -u personaldatahub -i

# Clone and build
cd ~ && git clone https://github.com/AISmithLab/PersonalDataHub.git
cd PersonalDataHub && pnpm install && pnpm build

# Initialize (save the owner password it prints)
npx pdh init

# Start the server
npx pdh start

exit
```

---

## 3. Configure Your Main User

Back as your main user, create the PDH config so the CLI knows where the server lives:

```bash
mkdir -p ~/.pdh
echo '{"hubUrl":"http://localhost:3000","hubDir":"/Users/personaldatahub/PersonalDataHub"}' > ~/.pdh/config.json
```

On Linux, replace `/Users/personaldatahub` with `/home/personaldatahub`.

---

## 4. Connect Your Sources via OAuth

Open `http://localhost:3000` in the `personaldatahub` user's browser session.

1. Click **Connect Gmail** — authenticate via Google's OAuth2 consent screen
2. Click **Connect GitHub** — authenticate via GitHub's OAuth2 flow
3. Configure **quick filters** to control what agents can see

> To use your own OAuth credentials instead of the defaults, see [OAuth Setup](OAUTH-SETUP.md).

---

## 5. Connect OpenClaw

Install the PersonalDataHub skill from ClawHub:

```bash
clawhub install personaldatahub
```

---

## Why User Separation?

OpenClaw agents may have broader filesystem access than MCP-based agents like Claude Code. Running PersonalDataHub as a separate OS user ensures:

- **OAuth tokens** are stored in files owned by `personaldatahub` with `0600` permissions — your agent process cannot read them
- **The SQLite database** (containing the audit log and filter config) is similarly protected
- **The encryption key** in `hub-config.yaml` is inaccessible to the agent

Without user separation, any process running as your main user could read the OAuth tokens directly and bypass PersonalDataHub's access controls entirely.

For the full threat model, see [SECURITY.md](SECURITY.md).
