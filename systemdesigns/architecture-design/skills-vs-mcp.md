# Skills vs MCP: Architectural Rationale

## The two integration layers

PersonalDataHub supports two distinct integration layers for AI agents. They are complementary, not competing.

### MCP Tools — low-level primitives

MCP (Model Context Protocol) exposes typed, discoverable tools that any compatible agent can call:

| Tool | Purpose |
|------|---------|
| `read_emails` | Pull emails (with query, limit) |
| `draft_email` | Propose a draft (staged for review) |
| `send_email` | Propose sending (staged for review) |
| `reply_to_email` | Propose a reply (staged for review) |

**Characteristics:**
- **Universal** — works in Claude Code, Cursor, Windsurf, or any MCP-compatible client
- **Discoverable** — agents can list available tools and schemas at runtime; tools are registered dynamically based on which sources have OAuth tokens
- **Typed** — parameters are validated (Zod schemas), providing a clear contract
- **Stateless** — each tool call is atomic; the agent decides how to chain them
- **Transport-only** — MCP tools are thin wrappers around the REST API (`/app/v1/pull`, `/app/v1/propose`); they add discoverability but no logic

### Claude Code Skills — high-level workflows

A skill is a `SKILL.md` prompt file that teaches Claude a multi-step workflow. The skill orchestrates tool calls, reasoning, and user interaction.

**Characteristics:**
- **Workflow-oriented** — encodes multi-step reasoning ("search first, then analyze, then draft")
- **Claude Code-specific** — only works in Claude Code (invoked via `/skill-name`)
- **Zero infrastructure** — just a markdown file, no server process needed
- **Flexible** — can mix REST calls, file reads, user interaction, and LLM reasoning in one workflow
- **Semantic** — handles intent parsing, context extraction, and content generation that typed tools cannot

## Where filtering happens

This is the key architectural distinction. There are two kinds of filtering, and they belong to different layers:

### Policy filtering — the Gateway's job

The PersonalDataHub gateway enforces the data owner's access control policy:

- **Boundary constraints** — date ranges, label restrictions (config-level)
- **QuickFilters** — exclude senders, hide fields, keyword filters (runtime rules)
- **Audit logging** — every pull is logged with the agent's stated purpose

This filtering is **mandatory and non-bypassable**. It runs server-side regardless of whether the request comes from MCP, REST, or a skill. The agent never sees data outside the owner's policy.

### Semantic filtering — the Skill's job

Given a user request like:

> "I've been discussing a proposal with Diego@UCSF. We mentioned a few candidates in the law school. Help me draft an introduction email."

The skill must:

1. **Parse intent** — identify people (Diego), institutions (UCSF), topics (proposal, law school candidates), and the desired output (introduction email)
2. **Construct queries** — translate intent into Gmail search syntax (`from:diego subject:proposal`, etc.)
3. **Evaluate results** — read the returned emails and determine which threads are relevant, which candidates were mentioned by name
4. **Synthesize** — compose a draft email using the extracted context
5. **Iterate** — if the first query doesn't surface enough context, refine and search again

**MCP tools cannot do this.** They are stateless primitives — `read_emails` takes a query string and returns results. It doesn't reason about what query to construct or whether the results are relevant.

### The separation

```
User: "Help me draft an intro email about the proposal with Diego"
    │
    ▼
┌─────────────────────────────────────────────┐
│  Skill layer (Claude reasoning)             │
│  - Parse intent: people, topics, email type │
│  - Build query: from:diego subject:proposal │
│  - Analyze results: extract candidates      │
│  - Compose draft introduction email         │
└──────────────────┬──────────────────────────┘
                   │ REST API calls
                   ▼
┌─────────────────────────────────────────────┐
│  Gateway layer (PersonalDataHub)            │
│  - Apply boundary (date range, labels)      │
│  - Apply QuickFilters (field hiding, etc.)  │
│  - Audit log (purpose, items returned)      │
│  - Stage proposed actions for owner review  │
└─────────────────────────────────────────────┘
```

The skill decides **what to ask for** (semantic). The gateway decides **what the agent is allowed to see** (policy). These are orthogonal concerns.

## Why not put workflow logic in MCP?

One could imagine a "smart" MCP tool like `email_assistant` that accepts a natural language request and does the multi-step workflow server-side. We chose not to do this because:

1. **Separation of concerns** — the gateway's job is access control, not LLM reasoning. Adding orchestration logic to the gateway couples two independent concerns.
2. **No LLM on the gateway** — the gateway is a lightweight Node.js server. Running LLM inference for intent parsing and content generation would require an API key, add latency, and increase cost — all for something the agent already does natively.
3. **Transparency** — when the skill runs in Claude Code, every step is visible to the user (the search queries, the emails found, the reasoning, the draft). A server-side workflow would be opaque.
4. **Flexibility** — different agents may want different workflows. A Cursor user might want a different multi-step flow than a Claude Code user. Keeping workflows in skills/prompts makes them easy to customize without changing the gateway.

## When to use which

| Scenario | Use |
|----------|-----|
| Agent needs to discover what data sources are available | MCP |
| Agent platform is not Claude Code (Cursor, Windsurf, etc.) | MCP |
| Simple one-shot operations (read emails, draft a reply) | MCP or REST |
| Multi-step workflow with reasoning (the email use case) | Skill calling REST |
| Programmatic integration (CI/CD, scripts, webhooks) | REST API directly |

## REST as the common denominator

Both MCP tools and skills ultimately call the same REST endpoints:

- `POST /app/v1/pull` — pull data with policy filtering
- `POST /app/v1/propose` — stage an action for owner review
- `GET /app/v1/sources` — discover connected sources

MCP wraps these for agent discoverability. Skills call them directly for workflow orchestration. The REST API is the stable, universal interface.
