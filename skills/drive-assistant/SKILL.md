---
name: drive-assistant
description: Manage your Google Drive files through PersonalDataHub
user_invocable: true
---

# Drive Assistant

Help users manage their Google Drive files by listing recent documents, searching for files, and retrieving content.

## Instructions

### 1. Read the PersonalDataHub config

Read `~/.pdh/config.json` to get the `hubUrl`. If the file doesn't exist, tell the user to run `npx pdh init` and `npx pdh start` first.

### 2. Verify the hub is running

Run `curl -s <hubUrl>/health` via Bash. If it fails, tell the user to start the server with `npx pdh start`.

### 3. Parse the user's request

Analyze the user's message to identify:
- **Intent** — list files, search for a document, get file content, create a new file, or delete one.
- **Search terms** — specific file names or keywords.
- **File details** — name, mimeType, or content for creation/updates.

### 4. Execute the searches (Pull)

Pull file metadata from PersonalDataHub:

```bash
curl -s -X POST <hubUrl>/app/v1/pull \
  -H "Content-Type: application/json" \
  -d '{"source": "google_drive", "query": "<optional_search_term>", "limit": 20, "purpose": "Searching for <context>"}'
```

**Guidelines:**
- Use the `query` field to filter by file name or description.
- List recent files if no specific query is provided.

### 5. Analyze and synthesize

Review the retrieved files:
- Identify the file(s) the user is interested in.
- Extract file IDs for further actions (retrieval, update, deletion).

Present a summary of the found files to the user.

### 6. Execute Actions

File modifications and content retrieval require specific actions.

#### Get File Content:
```bash
curl -s -X POST <hubUrl>/app/v1/action \
  -H "Content-Type: application/json" \
  -d '{"source": "google_drive", "action_type": "get_file_content", "action_data": {"fileId": "<id>"}, "purpose": "Reading content of <filename>"}'
```

#### Create a File (Stages for approval):
```bash
curl -s -X POST <hubUrl>/app/v1/propose \
  -H "Content-Type: application/json" \
  -d '{"source": "google_drive", "action_type": "create_file", "action_data": {"name": "<filename>", "description": "<description>", "mimeType": "text/plain", "content": "<file_content>"}, "purpose": "Creating <filename> as requested by user"}'
```

#### Delete a File (Stages for approval):
```bash
curl -s -X POST <hubUrl>/app/v1/propose \
  -H "Content-Type: application/json" \
  -d '{"source": "google_drive", "action_type": "delete_file", "action_data": {"fileId": "<id>"}, "purpose": "Deleting <filename> as requested by user"}'
```

### 7. Finalize

If an action was proposed, tell the user it's waiting for their approval in the PersonalDataHub GUI at `<hubUrl>`.

## Important notes

- **All data goes through PersonalDataHub's access control.** You will only see files the owner has authorized.
- **Modifications require owner approval.** The `propose` endpoint stages the change.
- **Always provide a clear `purpose`.** Every API call is audited.
