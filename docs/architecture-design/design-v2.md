# PersonalDataHub v2 Design

## What changed from v1

v1 added MCP server, source-specific tools, owner authentication, and process isolation via a dedicated OS user. v2 addresses deployment concerns: auto-start on reboot, browser session security for the admin GUI, and multi-platform support.

### Added
- **`install-service` / `uninstall-service` CLI commands** — generate a systemd unit (Linux) or launchd plist (macOS) so the server starts automatically on reboot.
- **`isRunningAsPdhUser()` detection** — `init` and `start` commands skip sudo when already running as the `personaldatahub` user, so the system user doesn't need sudo privileges.

---

## Browser session security

When the owner logs into the PersonalDataHub GUI, a session cookie (`pdh_session`) is stored in the browser. This cookie grants access to admin endpoints: approving staged actions, changing filters, disconnecting sources, and managing OAuth tokens.

### The threat

An AI agent with shell access (Claude Code, Cursor, etc.) running as the main user can read the browser's cookie store on disk:

| Browser | Cookie store path |
|---------|------------------|
| Chrome (Linux) | `~/.config/google-chrome/Default/Cookies` |
| Chrome (macOS) | `~/Library/Application Support/Google/Chrome/Default/Cookies` |
| Firefox (Linux) | `~/.mozilla/firefox/<profile>/cookies.sqlite` |
| Firefox (macOS) | `~/Library/Application Support/Firefox/Profiles/<profile>/cookies.sqlite` |
| Safari (macOS) | `~/Library/Cookies/Cookies.binarycookies` |

If the agent extracts the `pdh_session` cookie, it can call admin endpoints without the owner's knowledge — approving its own staged actions, disabling filters to see more data, or changing source boundaries.

Note: Chrome encrypts cookies using the system keychain (macOS) or DPAPI/gnome-keyring (Linux), which adds a layer of protection. Firefox and Safari have their own encryption. However, these protections are designed to prevent other users from reading cookies, not processes running as the same user. An agent running as the main user has the same access as the browser itself.

### Mitigations

The goal is to ensure the session cookie is stored in a location the agent cannot access.

**SSH tunnel (recommended for servers):** If PersonalDataHub runs on a remote server, SSH tunnel to it from your local machine (`ssh -L 3000:localhost:3000 user@server`). The session cookie lives in your local browser — the agent on the server has no way to access it. This is the strongest isolation because the cookie never exists on the same machine as the agent.

**Separate OS user browser session (desktops):** On macOS or Linux desktop, open the browser as the `personaldatahub` user. The browser profile and cookie file are owned by `personaldatahub` with `0600` permissions. The agent running as the main user cannot read them. This works but requires managing a separate desktop session (Fast User Switching on macOS, TTY switching on Linux).

**Same-user browser (weakest):** If you open the GUI in your main user's browser, the agent can theoretically read the cookie. This is acceptable if you trust the agent not to access your browser's cookie store, or if you're in a development/testing environment where the threat model is relaxed.

### Recommendation

For production deployments, use SSH tunneling from a separate machine. For desktop/development use, a separate desktop session provides good protection. The [Setup Guide](../SETUP.md) documents all three approaches.
