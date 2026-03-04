---
name: email-assistant
description: Draft email responses by pulling context from Gmail through PersonalDataHub
user_invocable: true
---

# Email Assistant

Given a natural language email request, search for relevant emails through PersonalDataHub, analyze the context, and draft a response.

## Instructions

### 1. Read the PersonalDataHub config

Read `~/.pdh/config.json` to get the `hubUrl`. If the file doesn't exist, tell the user to run `npx pdh init` and `npx pdh start` first.

### 2. Verify the hub is running

Run `curl -s <hubUrl>/health` via Bash. If it fails, tell the user to start the server with `npx pdh start`.

### 3. Parse the user's request

Analyze the user's message to identify:
- **People** — names, email addresses, affiliations (e.g., "Diego@UCSF")
- **Topics** — subjects, keywords, project names (e.g., "proposal", "law school")
- **Time context** — any mentioned timeframes ("last month", "recently")
- **Desired output** — what kind of email to draft (introduction, follow-up, reply, etc.)
- **Missing information** — what needs to be found in the email threads

### 4. Search for relevant emails

Build one or more Gmail search queries from the parsed context and pull emails via the PersonalDataHub REST API. Use Bash with curl:

```bash
curl -s -X POST <hubUrl>/app/v1/pull \
  -H "Content-Type: application/json" \
  -d '{"source": "gmail", "query": "<gmail-search-query>", "limit": 20, "purpose": "<why this search is needed>"}'
```

**Query construction tips:**
- `from:diego` — emails from a person
- `to:diego` — emails to a person
- `subject:proposal` — keyword in subject
- `"law school"` — exact phrase in body
- `newer_than:90d` — recent emails
- Combine: `from:diego subject:proposal newer_than:90d`

Run multiple searches if needed to gather sufficient context. For example, search by sender first, then by topic if the first search is too broad.

### 5. Analyze the email context

Review the returned emails and extract:
- The conversation thread and its progression
- Key details (names, dates, decisions, open questions)
- Specific information the user asked about (e.g., "candidates we mentioned")
- Thread IDs for reply threading

Present a brief summary of what you found to the user before drafting.

### 6. Compose the draft

Write the email draft based on:
- The context extracted from the email threads
- The user's stated intent (introduction, follow-up, etc.)
- Appropriate tone and formality for the context

Show the draft to the user and ask if they'd like any changes.

### 7. Propose the draft through PersonalDataHub

Once the user approves the draft, propose it via the staging API:

```bash
curl -s -X POST <hubUrl>/app/v1/propose \
  -H "Content-Type: application/json" \
  -d '{"source": "gmail", "action_type": "draft_email", "action_data": {"to": "<recipient>", "subject": "<subject>", "body": "<body>"}, "purpose": "<why this draft is being created>"}'
```

If the email is a reply to an existing thread, include `"in_reply_to": "<threadId>"` in `action_data`.

Tell the user the draft has been proposed and is waiting for their approval in the PersonalDataHub GUI at `<hubUrl>`.

## Important notes

- **All data goes through PersonalDataHub's access control.** The gateway applies the owner's filters and policies. You will only see emails the owner has authorized.
- **Drafts require owner approval.** The `propose` endpoint stages the draft — it does NOT send. The owner must approve it in the PersonalDataHub GUI.
- **Always state your purpose.** Every pull and propose call requires a `purpose` string that gets logged in the audit trail.
- **Show your work.** Always show the user what emails you found and what context you extracted before drafting. Transparency is key.
