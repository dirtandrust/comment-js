# Comment Plugin

This document captures what has already been built for the comment system in this repo and how to set it up both here and in any other codebase.

This guide is intentionally separate from prototype/application docs. It only covers the reusable comment plugin module, its behavior, and setup.

## Scope

- Keep comment plugin decisions and setup instructions in this file.
- Do not treat this file as part of broader prototype UX/layout documentation.
- Use this as the source of truth when copying the plugin into another project.

## What We Have Built So Far

Comment plugin work landed in these commits:

- `d89f6967` - moved comment logic to its own module (`src/comment.js`) and wired it from `src/main.js`.
- `194e6d31` - added delete comment support with UI button and queue handling.
- `5314d864` - added ISO timestamp capture/storage on comment update.
- `001ffd28` - improved offline delete behavior so UI removes immediately and delete sync is retried later.

Current behavior in `src/comment.js`:

- Click anywhere on the page to create a pin at cursor coordinates.
- Click a pin to toggle its popup form.
- Comment form includes:
  - Type dropdown (`Idea/Suggestion`, `Copy/Content`, `Question`, `Bug` by default)
  - Comment textarea
  - Submit button (`Comment` / `Saving...` / `Saved!` / `Saved Offline` states)
  - Delete button with confirmation dialog
- Each pin has a stable `pinId` (zero-padded numeric string) generated from local queue state.
- Queue persistence in `localStorage`:
  - `comment-pin-queue-v1` for comment upserts
  - `comment-pin-delete-queue-v1` for pending deletes
- Offline-first sync behavior:
  - Saves locally first
  - Tries immediate POST to Google Apps Script endpoint
  - Retries pending comment/delete queues when network is restored
- Sync status badge (fixed bottom-right) shows:
  - `Synced`
  - `Syncing - Pending: ...`
  - `Offline - Pending: ...`
  - `Offline - All saved locally`
- On startup:
  - Restores existing pins/forms from local queue
  - Initializes pin counter from stored IDs
  - Flushes pending comment/delete queues

Styling for UI elements currently lives in `src/styles/globals.css` under the `/* Comment pins */` section.

## Current Integration In This Repo

This section is implementation context only (where the plugin is currently wired). The plugin itself is not coupled to prototype-specific UI architecture.

### 1) Module import

`src/main.js` imports the plugin:

```js
import { initCommentSystem } from "./comment.js";
```

### 2) Plugin init

`src/main.js` calls:

```js
initCommentSystem({
  googleScriptUrl: "https://script.google.com/macros/s/YOUR_DEPLOYMENT_ID/exec",
});
```

In this repo, there is already an Apps Script URL wired in `src/main.js`.

### 3) Required config

`googleScriptUrl` is required. Optional config keys:

- `localStorageKey` (default: `comment-pin-queue-v1`)
- `deleteQueueStorageKey` (default: `comment-pin-delete-queue-v1`)
- `syncStatusBadgeId` (default: `comment-sync-status-badge`)
- `pendingSyncRetryMs` (default: `5000`)
- `statusOptions` (default options listed above)

### 4) Start app locally

```bash
npm i
npm run start
```

Open `http://localhost:5173`.

### 5) Verify quickly

- Click empty area -> new pin appears.
- Fill type/comment -> click Comment.
- Toggle browser offline in DevTools and submit -> should show `Saved Offline`.
- Return online -> pending queue should flush and badge should move toward `Synced`.
- Delete an existing pin while offline -> pin should disappear immediately and delete should sync later.

## Setup On Any Other Codebase

Use this checklist to port the plugin into another app (vanilla JS, Vite, or similar DOM-based app).

### 1) Copy plugin module

Copy `src/comment.js` into your project (for example `src/plugins/comment.js`).

### 2) Add styles

Copy the comment-related CSS from `src/styles/globals.css`:

- `.comment-pin`
- `.comment-pin__caret`
- `.comment-pin.is-open .comment-pin__caret`
- `.comment-form-popup`
- `.comment-form-textarea`
- `.comment-form-type`
- `.update-btn`
- `.delete-btn`

You can rename classes, but then update selectors in the JS module to match.

### 3) Initialize once after app mount

```js
import { initCommentSystem } from "./plugins/comment.js";

initCommentSystem({
  googleScriptUrl: "https://script.google.com/macros/s/YOUR_DEPLOYMENT_ID/exec",
  statusOptions: ["Idea", "Question", "Bug", "Data"],
});
```

Call it once after the document/body is ready and visible.

### 4) Backend endpoint contract

The plugin posts JSON with `fetch(..., { method: "POST", mode: "no-cors" })`.
Your endpoint should accept:

Comment upsert payload:

```json
{
  "pinId": "03",
  "timestamp": "2026-05-25T10:15:30.000Z",
  "date": "2026-05-25T10:15:30.000Z",
  "xCoordinate": "823px",
  "yCoordinate": "412px",
  "commentText": "Need to adjust this control",
  "status": "Idea/Suggestion"
}
```

Delete payload:

```json
{
  "pinId": "03",
  "action": "delete",
  "deletedAt": 1770000000000
}
```

### 5) Minimal Google Apps Script example

If you use Google Sheets, this `doPost` is a baseline:

```javascript
function doPost(e) {
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName("Comments");
  var body = JSON.parse(e.postData.contents || "{}");

  if (body.action === "delete") {
    var values = sheet.getDataRange().getValues();
    for (var i = values.length - 1; i >= 1; i--) {
      if (String(values[i][0]) === String(body.pinId)) {
        sheet.deleteRow(i + 1);
      }
    }
    return ContentService.createTextOutput("ok");
  }

  // Columns: pinId, timestamp, xCoordinate, yCoordinate, commentText, status
  var values = sheet.getDataRange().getValues();
  var foundRow = -1;
  for (var j = 1; j < values.length; j++) {
    if (String(values[j][0]) === String(body.pinId)) {
      foundRow = j + 1;
      break;
    }
  }

  var rowData = [
    body.pinId || "",
    body.timestamp || body.date || "",
    body.xCoordinate || "",
    body.yCoordinate || "",
    body.commentText || "",
    body.status || "",
  ];

  if (foundRow > 0) {
    sheet.getRange(foundRow, 1, 1, rowData.length).setValues([rowData]);
  } else {
    sheet.appendRow(rowData);
  }

  return ContentService.createTextOutput("ok");
}
```

Deploy as Web App and use the `/exec` URL.

## Known Constraints

- Plugin currently binds a global `document.click` handler. If your app has other global click workflows, test interactions carefully.
- Coordinates are stored as page pixel strings (for example `"823px"`). If your target app uses transformed/scaled canvases, consider mapping to container-relative coordinates.
- `mode: "no-cors"` means client cannot inspect response body/status. Reliability is handled by local queues + retries.
- There is no authentication/authorization layer in the plugin. Add abuse protection and endpoint validation before production use.

## Suggested Hardening (Future)

- Add scoped target container support instead of using full `document` click capture.
- Add configurable placement strategy (`page`, `viewport`, or container-relative coordinates).
- Add optional keyboard shortcut to enter/exit comment mode.
- Add lightweight unit tests for queue and payload functions.
- Add e2e tests for offline create/update/delete replay.

## File Map (This Repo)

- Plugin logic: `src/comment.js`
- Plugin wiring: `src/main.js`
- Plugin styles: `src/styles/globals.css`
- This guide: `comment-plugin.md`
