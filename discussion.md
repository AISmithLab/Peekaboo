# Peekaboo Design Discussions

## Session 1: Initial Design & Implementation Plan Review

### Step 7 — Pipeline Engine
- Updated to account for `store` operator
- Three operator categories: **producers** (pull), **transformers** (select, filter, transform), **side-effect operators** (store, stage)
- `store` is pass-through (data flows through it), `stage` is terminal

### Step 8 — Audit Log
- Event names aligned with design.md: `data_pull`, `cache_write`, `action_proposed`, `action_approved`, `action_rejected`, `action_committed`
- Added `logCacheWrite` method
- Every event includes a `purpose` field (provided by the app)

### Step 9 — HTTP Server and App API

**Major simplifications:**

- **Removed middleware abstraction**: Originally had 4 separate middleware files. User asked "why do we need these middleware APIs?" — too much for 2 routes. Fixed by doing auth inline in route handlers.
- **Reduced to 2 endpoints**: Originally had `/sources`, `/health`, `/actions/:id`, `/manifest` plus more. User said "it seems only need two APIs":
  - `POST /app/v1/pull` — pull data from a source
  - `POST /app/v1/propose` — propose an outbound action (staged for owner review)
- **Renamed "plugin" to "app"**: User said "instead of call it plugin, may just call it app" — renamed all `/plugin/v1/` → `/app/v1/`, `plugin-api.ts` → `app-api.ts` throughout.
- **Manifests made internal**: User said "manifests are hidden to most users. we create the manifests based on how the users interact with the access control GUI" — removed manifest submission endpoint. Apps never see manifests.
- **Added `purpose` field**: User said "The extension simply sends the request to the manifest, while summarizing the purpose. The purpose should be stored in the audit database" — both endpoints require a `purpose` string, logged to audit.

### Step 10 — Owner API: REMOVED
- User said "step 10 is already covered by step 9. could you validate?"
- Owner interacts with DB directly via the GUI — no need for a separate Owner API.
- Audit log is written internally, no external API needed.

### Step 10 (was 11) — GitHub Connector
- User said "the description of step is not accurate. for github, it only manages the data access. no need to work with data directly"
- Rewritten as **access control only** — not a data connector
- Manages which repos the agent account can access via GitHub's collaborator API
- The agent uses its own scoped GitHub credentials for reads/writes

### Step 11 (was 12) — Gmail Connector
- True data connector with `sync()` method
- User asked about periodic sync: "the gmail connector should also be able to sync with the server every certain minutes/hours"
- Added configurable sync interval (cron-like) to trigger Gmail pull periodically
- All fields go into `data: Record<string, unknown>` (flexible schema)
- `executeAction` method called by GUI for approved staged actions

### Step 12 (was CLI) — Owner GUI
- User said "no need for CLI. only need a GUI"
- **Tab-based layout**: Each service gets its own tab (Gmail, GitHub) + Settings tab
- **OAuth flows**: User connects services through the GUI (e.g., Gmail OAuth, GitHub PAT)
- **Access control toggles → manifests**: User said "For gmail, there would be a few common access control options, such as only pulling future emails, only pulling email content without sender information, etc. Think about the most common usages. Given what the user select, we will convert them into manifests."
- **Preset manifests for Gmail**:
  1. Read-only recent emails (with redaction)
  2. Metadata only (no body content)
  3. Full access with redaction
  4. Email drafting (propose actions)

### Steps REMOVED (consolidated from 18 → 14)
- **Local Cache step**: Removed as redundant — lazy loading in `pull` + `store` operator + Gmail `sync()` already cover caching
- **Identity Manager step**: Removed as redundant — covered by manifest system and GUI toggles
- **Bundled Manifests step**: Removed — manifest generation moved into GUI (Step 12)

### Step 13 — E2E Tests
- User said "it would be hard to test github access. so no need to test. instead, have multiple tests for the options in the gmail tab"
- Gmail-focused tests matching the preset manifests

### Step 14 — PersonalDataHub OpenClaw Extension
- User said "Need to create an OpenClaw extension named PersonalDataHub. The PersonalDataHub will intelligently interact with the Peekaboo hub. For example, I can send a query like: Collect all my incoming and unanswered emails since this moment, draft a response to them. Then it will call the API in the personal data hub to query data and commit the stages."
- Extension sends requests with `purpose` string — doesn't know about manifests or policies
- Two tools: `personal_data_pull` and `personal_data_propose`

### Final Consistency Pass
- Renamed all "plugin" → "app" across design.md and implementationplan.md
- Fixed `source_metadata` → actual field names in V1 example manifests
- Removed stale references to Owner API, CLI, Identity Manager, Plugin State table
- Updated project structure, tech stack descriptions, security table

---

## Session 2: REST API Parameter Format

### Issue: Pseudo-code vs actual REST payloads (implementationplan.md line 584)

User noted that the example workflows in Step 14 used pseudo-code function calls like:
```
pull("gmail", "email", { time_window: "today", is_unread: true }, purpose: "...")
```

This doesn't map clearly to the REST API. The actual `POST /app/v1/pull` endpoint accepts a JSON body.

**Two approaches considered:**

1. **Gmail query syntax in `params.query`** — the app passes a Gmail search string like `"is:unread newer_than:1d"` and the Hub forwards it to the Gmail API. Simple, but requires the app to know Gmail query syntax.

2. **Structured keys in `params`** — the app sends `{ "is_unread": true, "after": "2026-02-21" }` and the Hub connector translates them into the Gmail query. More abstracted, but more work in the connector.

**Decision: Pragmatic hybrid (Option 1 primary)**

- `params.query` — freeform string using Gmail search syntax (e.g., `"is:unread newer_than:1d"`, `"from:alice Q4 report"`). The Hub connector passes it directly to Gmail's `q` parameter. No translation layer needed.
- `params.limit` — optional, controls max results returned.
- **Boundary enforcement** — the Hub automatically applies the owner's configured boundary (e.g., `after: "2026-01-01"`) on top of whatever query the app sends. The app can't override it.

Updated all Step 14 examples to show actual REST JSON payloads:

```json
// Pull example
POST /app/v1/pull
{ "source": "gmail", "type": "email", "params": { "query": "is:unread newer_than:1d" }, "purpose": "Collect unanswered emails to draft responses" }

// Propose example
POST /app/v1/propose
{ "source": "gmail", "action_type": "draft_email", "action_data": { "to": "alice@company.com", "subject": "Re: Q4 Report", "body": "...", "in_reply_to": "msg_abc123" }, "purpose": "Draft reply to unanswered email from Alice about Q4 report" }
```

---

## Key Design Decisions Summary

| Decision | Rationale |
|---|---|
| Only 2 App API endpoints (pull, propose) | Minimizes API surface. Everything else is internal. |
| No Owner API | Owner interacts with DB directly via GUI. |
| No CLI | GUI covers all owner operations. |
| "App" not "plugin" | Cleaner terminology. |
| Manifests are internal | Generated by GUI from access control toggles. Apps never see them. |
| Apps send `purpose` with every request | Stored in audit log for accountability. |
| GitHub = access control only | Agent uses its own scoped GitHub credentials. Hub just manages which repos are accessible. |
| Gmail = true data connector | Hub fetches data via owner credentials, serves through pipeline. |
| `params.query` uses Gmail search syntax | No translation layer needed. Hub applies boundary on top. |
| 14 implementation steps (down from 18) | Removed redundant steps: Owner API, Local Cache, Identity Manager, Bundled Manifests, CLI. |
