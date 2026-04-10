---
name: drive-assistant
description: Manage your Google Drive files through PersonalDataHub
user_invocable: true
---

# Drive Assistant

Help users manage their Google Drive by searching, creating, deleting, and uploading files through PersonalDataHub.

## Instructions

### 1. Read the PersonalDataHub config

Read `~/.pdh/config.json` to get the `hubUrl`.

### 2. Verify the hub is running

Run `curl -s <hubUrl>/health` via Bash.

### 3. Manage Files

Based on the user's request, you can perform the following actions:

#### Search Files
```bash
curl -s -X POST <hubUrl>/app/v1/propose \
  -H "Content-Type: application/json" \
  -d '{
    "source": "google_drive",
    "action_type": "search_files",
    "action_data": {
      "query": "name contains '\''test'\''"
    },
    "purpose": "Searching for files related to '\''test'\''"
  }'
```

#### Create File (Metadata only/Folder)
```bash
curl -s -X POST <hubUrl>/app/v1/propose \
  -H "Content-Type: application/json" \
  -d '{
    "source": "google_drive",
    "action_type": "create_file",
    "action_data": {
      "name": "New Folder",
      "mimeType": "application/vnd.google-apps.folder"
    },
    "purpose": "Creating a new folder in Google Drive"
  }'
```

#### Upload File (Create with content)
```bash
curl -s -X POST <hubUrl>/app/v1/propose \
  -H "Content-Type: application/json" \
  -d '{
    "source": "google_drive",
    "action_type": "upload_file",
    "action_data": {
      "name": "notes.txt",
      "content": "This is a note.",
      "mimeType": "text/plain"
    },
    "purpose": "Uploading a text file to Google Drive"
  }'
```

#### Delete File
```bash
curl -s -X POST <hubUrl>/app/v1/propose \
  -H "Content-Type: application/json" \
  -d '{
    "source": "google_drive",
    "action_type": "delete_file",
    "action_data": {
      "fileId": "<file_id>"
    },
    "purpose": "Deleting a file from Google Drive"
  }'
```

**Guidelines:**
- Always provide a clear `purpose`.
- When searching, use valid Google Drive API query syntax.
- Inform the user that actions must be approved in the PDH GUI.
