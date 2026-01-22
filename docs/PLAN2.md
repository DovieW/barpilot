# BARPILOT_NOTES.md

## Overview
These are implementation and product considerations that materially impact robustness, user trust, and Chrome Web Store viability for **BarPilot** (context-switched Bookmarks Bar).

---

## 1) Bookmark Sync: the dominant risk factor
### Problem
If the user has Chrome bookmark sync enabled across multiple devices:
- BarPilot’s bar rewrites will **sync everywhere**.
- Two devices focused on different sites can cause **continuous flipping** of the global bar.

### Mitigations (ship in v1)
- **First-run warning** explaining sync implications and how to avoid thrash.
- Modes:
  - **Automatic** (default)
  - **Manual** (hotkey/popup only; no auto switching)
  - **Local UI (no writes)**: show per-site set in popup/side panel without modifying bookmarks
- Conservative defaults:
  - `minIntervalMs >= 2000`
  - dwell time enabled by default

---

## 2) Multi-window ambiguity requires an explicit policy
### Problem
Bookmarks Bar is global. With multiple Chrome windows, “active tab” differs per window.

### Recommended default
- Follow the **focused window only**.
- Ignore tab changes in background windows.
- Provide:
  - **Lock** (freeze)
  - **Pause for X minutes** (5/15/60) to reduce friction

---

## 3) MV3 service worker lifecycle implications
### Problem
MV3 background is suspended frequently; in-memory state is unreliable.

### Requirements
- Persist operational state in `chrome.storage.local`:
  - `inProgress`, `pendingHost`, timestamps, last applied host, etc.
- Make all operations **idempotent**:
  - safe to retry after interruption
  - safe to clean up partial staging folders
- Startup routines:
  - detect/cleanup stale staging folder
  - clear stale inProgress lock (e.g., older than 30s)

---

## 4) Instant vs stable switching is a UX trade-off
### Problem
Switching on every tab activation can feel “hyperactive” and annoying.

### Recommendations
- Default to **debounce + dwell** and a **minimum interval**.
- Optional user setting:
  - “Switch on navigation only” (URL change in same tab)
  - vs “Switch on activation” (when you click a tab)

---

## 5) User edits must not be punished
### Problem
Users will drag bookmarks around or add items to the bar.

### Rules
- Never delete/move items you didn’t create.
- Provide a “Re-render / Reconcile” button:
  - rebuild managed region from the current set
  - leave unknown items intact (or optionally move them to Pinned/Trash)

---

## 6) Marker / boundary object for the managed region
### Problem
Using only indices (pinnedCount) can be confusing.

### Recommendation
Insert a clearly labeled folder marker after pinned items:
- `— BarPilot —` or `BarPilot: Managed`
This improves:
- user understanding
- safe identification of the managed region

---

## 7) Preview / dry-run in Options
### Purpose
Reduce user fear and prevent “it rearranged everything” moments.

### Behavior
- User selects a host and target set
- Click **Preview (one-time render)**:
  - show what will be pinned vs managed
  - show counts of items to be created
  - optionally show a diff summary

---

## 8) Permissions hygiene and trust messaging
### Permissions needed
- `bookmarks` — to read/write the bookmarks bar
- `tabs` — to know current site
- `storage` — to store rules, state, snapshots
- optional `alarms` — periodic cleanup/verification

### Required trust assets
- README and store listing: “Why we need these permissions”
- No content scripts; background-only.
- No telemetry by default.

---

## 9) Emergency stop and quick restore are mandatory
### Must-have UI
Action popup should include:
- **Enable/Disable**
- **Lock/Unlock**
- **Restore last backup**
- **Re-render now**
- Optional: **Pause 15 minutes**

Also consider a keyboard shortcut for lock/unlock.

---

## 10) Low-write alternative mode (high value)
### Rationale
Some users will want contextual bookmarks without rewriting synced bookmarks.

### Approach
- Popup or side panel view of the current set
- “Open all in folder” and quick search
- No writes to bookmarks bar at all

This also de-risks sync thrash and reviewer/user concerns.

---

## 11) Schema versioning and migrations
### Why
Rules, set IDs, and internal markers will evolve.

### Do
- Store `schemaVersion`
- On startup, run migrations deterministically

---

## 12) Telemetry: default to none
### Recommendation
- No telemetry in v1.
- If diagnostics are later needed:
  - keep local-only
  - allow export as a “debug report” text blob
  - be explicit and opt-in for any external sending

---

## Top 5 “must-do” checklist for v1
1. Bookmark Sync warning + Manual/Lock modes
2. Focused-window-only switching policy + dwell + min interval
3. Two-phase staging swap + backups + trash (never touch canonical)
4. MV3 idempotent engine with persisted state and stale-lock cleanup
5. Managed region marker + one-click Restore + Re-render
