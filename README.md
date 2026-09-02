# Comment.js Plugin

This document describes the purpose, public API, and runtime behavior of the reusable comment plugin module.

## Purpose

`comment.js` provides an in-page comment pin system for DOM-based web apps. It allows users to place pins, attach structured comments, store changes locally, and sync comment updates/deletes to a backend endpoint.

Core goals:

- Let users drop comment pins directly on the page.
- Keep comment data safe during offline/network interruptions.
- Replay pending updates automatically when connectivity returns.
- Provide visual sync state so users know whether data is synced or queued.

## Public API

The module exports one function:

```js
import { initCommentSystem } from "./comment.js";

initCommentSystem({
  googleScriptUrl: "https://your-endpoint.example/exec",
});
```

Initialize once after the page has mounted and `document.body` is available.

## initCommentSystem Configuration

### Required

- `googleScriptUrl`: string URL for POST requests.

### Optional

- `localStorageKey` (default: `comment-pin-queue-v1`)
- `deleteQueueStorageKey` (default: `comment-pin-delete-queue-v1`)
- `syncStatusBadgeId` (default: `comment-sync-status-badge`)
- `pendingSyncRetryMs` (default: `5000`)
- `dragThresholdPx` (default: `8`)
- `commentBoxDefaultWidthPx` (default: `200`)
- `popupAnchorOffsetPx` (default: `16`)
- `statusOptions` (default: `Idea/Suggestion`, `Copy/Content`, `Question`, `Bug`)
- `anchorBinding` (default: `null`)
- `onDemo` (default: `null`)

## Runtime Behavior

### Pin Creation and Interaction

- Click on the page to create a new pin.
- Click a pin to toggle its comment popup.
- Only one popup is shown at a time.
- Pointer-move threshold prevents accidental pin creation after drag gestures.

### Comment Form

Each popup contains:

- Hidden timestamp field
- Type dropdown (`statusOptions`)
- Comment textarea
- Submit button (`Comment`, `Saving...`, `Saved!`, `Saved Offline`)
- Delete button with confirmation

### Queueing and Persistence

- Comment upserts are stored in local storage queue.
- Deletes are stored in a separate local storage queue.
- Pins are restored from local data on startup.
- Pin IDs are stable, sequential, and zero-padded.

### Sync Model

- Plugin writes locally first, then attempts network sync.
- If offline or request fails, items remain pending.
- Pending comment and delete queues are retried automatically.
- Browser `online` event triggers queue flush attempts.

### Sync Status Badge

Plugin renders a fixed status badge indicating:

- `Synced`
- `Syncing • Pending: N`
- `Offline • Pending: N`
- `Offline • All saved locally`

If `onDemo` is supplied, a `Demo` button is rendered next to the badge and calls the provided callback.

### Positioning

- Pins and popups are absolutely positioned.
- Popup placement auto-adjusts to stay in viewport.
- Free pins store viewport-relative ratios and are repositioned on resize/orientation changes.

## Optional 3D Anchor Integration

When `anchorBinding` is provided, pins can bind to projected 3D anchors.

Expected shape:

- `anchorBinding.resolveAnchor(event)`
  - Returns `{ xCoordinate, yCoordinate, anchorData }` or `null`
- `anchorBinding.projectAnchor(anchorData)`
  - Returns `{ xCoordinate, yCoordinate, visible? }` or `null`

Anchored comments are continuously reprojected so they follow scene/camera changes.

## Network Payloads

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

Requests are sent with:

```js
fetch(googleScriptUrl, {
  method: "POST",
  mode: "no-cors",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(payload),
});
```

## CSS Classes Used by the Plugin

- `.comment-pin`
- `.comment-pin__caret`
- `.comment-pin.is-open .comment-pin__caret`
- `.comment-pin--anchored`
- `.comment-pin--free`
- `.comment-form-popup`
- `.comment-form-popup--anchored`
- `.comment-form-popup--free`
- `.comment-form`
- `.comment-form-type`
- `.comment-form-textarea`
- `.comment-input-field`
- `.update-btn`
- `.delete-btn`

## Constraints and Notes

- The plugin uses global document-level pointer/click listeners.
- `mode: "no-cors"` means response status/body is not readable by the client.
- Reliability is handled by local queues and retry behavior.
- Add authentication/authorization and abuse controls before production use.
