---
name: calendar-assistant
description: Manage your Google Calendar by checking availability and scheduling events through PersonalDataHub
user_invocable: true
---

# Calendar Assistant

Help users manage their schedule by checking for conflicts, listing upcoming events, and proposing new calendar items.

## Instructions

### 1. Read the PersonalDataHub config

Read `~/.pdh/config.json` to get the `hubUrl`. If the file doesn't exist, tell the user to run `npx pdh init` and `npx pdh start` first.

### 2. Verify the hub is running

Run `curl -s <hubUrl>/health` via Bash. If it fails, tell the user to start the server with `npx pdh start`.

### 3. Parse the user's request

Analyze the user's message to identify:
- **Intent** — list events, check availability, create a new event, update/delete an existing one.
- **Time context** — specific dates, relative times ("next Tuesday", "tomorrow afternoon").
- **Event details** — title, description, location, attendees.
- **Missing information** — required fields like start time, duration, or participant emails.

### 4. Plan the search strategy

Before scheduling or responding, check existing commitments. Plan queries for:
- **Current schedule** — Pull events for the relevant time range to check for overlaps.
- **Contextual data** — If the meeting relates to an email thread or GitHub issue, pull that data for context (titles, participants).

### 5. Execute the searches (Pull)

Pull calendar data from PersonalDataHub:

```bash
curl -s -X POST <hubUrl>/app/v1/pull \
  -H "Content-Type: application/json" \
  -d '{"source": "google_calendar", "query": "<optional_search_term>", "after": "<iso_timestamp>", "limit": 20, "purpose": "Checking availability for <context>"}'
```

**Guidelines:**
- Use the `after` field to limit results to relevant upcoming times.
- If checking a specific day, pull events for that entire 24h window.
- Deduplicate results if running multiple queries.

### 6. Analyze and synthesize

Review the retrieved events:
- Identify free slots.
- Note any direct conflicts.
- Extract event IDs if the user wants to update or delete a specific item.

Present a summary of the current schedule or the proposed time to the user.

### 7. Propose Actions

Calendar modifications require user approval via the `propose` endpoint.

#### Create an Event:
```bash
curl -s -X POST <hubUrl>/app/v1/propose \
  -H "Content-Type: application/json" \
  -d '{
    "source": "google_calendar",
    "action_type": "create_event",
    "action_data": {
      "title": "<summary>",
      "body": "<description>",
      "location": "<location>",
      "start": "<iso_timestamp>",
      "end": "<iso_timestamp>",
      "timeZone": "UTC",
      "attendees": [{"email": "user@example.com"}]
    },
    "purpose": "Scheduling <title> as requested by user"
  }'
```

#### Update an Event:
```bash
curl -s -X POST <hubUrl>/app/v1/propose \
  -H "Content-Type: application/json" \
  -d '{
    "source": "google_calendar",
    "action_type": "update_event",
    "action_data": {
      "eventId": "<id>",
      "title": "<new_summary>"
    },
    "purpose": "Updating event title"
  }'
```

#### Delete an Event:
```bash
curl -s -X POST <hubUrl>/app/v1/propose \
  -H "Content-Type: application/json" \
  -d '{
    "source": "google_calendar",
    "action_type": "delete_event",
    "action_data": { "eventId": "<id>" },
    "purpose": "Deleting cancelled event"
  }'
```

### 8. Finalize

Tell the user the action has been proposed and is waiting for their approval in the PersonalDataHub GUI at `<hubUrl>`.

## Important notes

- **All data goes through PersonalDataHub's access control.** You will only see events the owner has authorized.
- **Modifications require owner approval.** The `propose` endpoint stages the change — it does NOT immediately update the calendar.
- **Always provide a clear `purpose`.** Every API call is audited.
- **Show your work.** List the events you found that led to your recommendation or time suggestion.
