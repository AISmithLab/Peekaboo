---
name: overleaf-assistant
description: Compose and create LaTeX documents in Overleaf through PersonalDataHub
user_invocable: true
---

# Overleaf Assistant

Help users compose LaTeX documents and open them directly in Overleaf for final editing and compilation.

## Instructions

### 1. Read the PersonalDataHub config

Read `~/.pdh/config.json` to get the `hubUrl`. If the file doesn't exist, tell the user to run `npx pdh init` and `npx pdh start` first.

### 2. Verify the hub is running

Run `curl -s <hubUrl>/health` via Bash. If it fails, tell the user to start the server with `npx pdh start`.

### 3. Compose the LaTeX document

Based on the user's request, compose a complete and valid LaTeX document. Ensure all necessary packages and structure (preamble, document environment) are included.

### 4. Propose the document creation

Use the `propose` endpoint to send the document to PersonalDataHub for approval.

```bash
curl -s -X POST <hubUrl>/app/v1/propose \
  -H "Content-Type: application/json" \
  -d '{
    "source": "overleaf",
    "action_type": "create_document",
    "action_data": {
      "title": "<filename>.tex",
      "body": "<full_latex_content>"
    },
    "purpose": "Creating LaTeX document: <description>"
  }'
```

**Guidelines:**
- The `body` must contain the entire LaTeX source code.
- The `title` should be a descriptive filename ending in `.tex`.
- Provide a clear `purpose` explaining what the document is for.
- Do not double-escape with `\\`. The output LaTeX code should be readable by a human with line breaks and proper syntax.

### 5. Finalize

Inform the user that the document has been proposed. Explain that once they **Approve** the action in the PersonalDataHub GUI at `<hubUrl>`, a new tab will automatically open with their document pre-loaded in Overleaf.

## Important notes

- **User Approval is Required**: No data is sent to Overleaf until the user explicitly approves the staged action in the PDH GUI.
- **Single File only**: This workflow currently supports creating a single `.tex` file in a new Overleaf project.
- **Privacy**: The document content is sent to Overleaf's servers only when the user clicks Approve.
