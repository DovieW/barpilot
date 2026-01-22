# BarPilot manual test plan (detailed)

This document is a **manual testing playbook** to verify BarPilot’s:

- core functionality (switching the bar by site)
- safety guarantees (no canonical set modification, recoverability)
- user-trust behavior (don’t punish manual edits)
- MV3 robustness (service worker suspension / crash tolerance)

It’s written so you can follow it step-by-step without needing to read the code.

---

## Before you start

### Safety warning (please read)

BarPilot writes to your bookmarks. It *tries* to be safe, but while testing you should assume you can make a mess.

Recommended (choose one):

1. **Use a fresh Chrome profile** just for testing, OR
2. Export bookmarks first: Bookmarks Manager → ⋮ → **Export bookmarks**

### Supported browsers

- Chrome (MV3)
- Other Chromium browsers might work, but treat as “best effort”.

---

## Install & basic setup

### A. Install unpacked

1. Open `chrome://extensions`
2. Enable **Developer mode**
3. Click **Load unpacked**
4. Select the repo folder (`barpilot`)

Expected:
- BarPilot appears in the extensions list
- Opening the action popup shows controls (Enabled/Lock/etc.)

### B. Create canonical sets (source of truth)

In Bookmarks Manager (`chrome://bookmarks/`):

1. Create folders:
  - `Other Bookmarks / BarPilot / Sets / GitHub`
  - `Other Bookmarks / BarPilot / Sets / YouTube`
  - `Other Bookmarks / BarPilot / Sets / Default`
2. Put content inside each:
  - at least 5 bookmarks
  - at least 1 subfolder with 2 bookmarks

Expected:
- These folders exist and contain items.
- BarPilot should **never modify these folders**.

### C. Create rules + defaults (Options)

1. Open BarPilot **Options**
2. Set:
  - Mode: **Automatic**
  - Trigger: **On tab activation**
  - Pinned count: `2` (or whatever you want)
  - Default set: **Default**
3. Add rules:
  - `hostEquals` + `github.com` → GitHub
  - `hostEquals` + `youtube.com` → YouTube
4. Click **Save rules**

Expected:
- Refresh Options: rules are still there.

---

## Test group 1: Switching behavior (core)

### 1.1 Marker folder behavior

1. Ensure your bookmarks bar is visible.
2. Open a GitHub tab and a YouTube tab.
3. Click GitHub tab (or activate it).
4. Wait ~2 seconds.

Expected:
- Bookmarks bar contains your pinned items first.
- Immediately after pinned items there is a folder:
  - `— BarPilot —`
- Inside `— BarPilot —`, the contents match the GitHub set (top-level items).

### 1.2 Switching between sites

1. Click YouTube tab.
2. Wait ~2 seconds.

Expected:
- Items inside `— BarPilot —` now match the YouTube set.
- Your pinned items did not move.

### 1.3 Default set fallback

1. Open a site that has no rule (example: `example.com`).
2. Wait ~2 seconds.

Expected:
- Items inside `— BarPilot —` match the Default set.

---

## Test group 2: Safety guarantees

### 2.1 Canonical set immutability

1. Before switching, open Bookmarks Manager and note:
  - a bookmark title and URL inside `Sets / GitHub`
2. Switch sites a few times.
3. Re-check the same canonical set bookmark.

Expected:
- The canonical bookmark is unchanged (same title, same URL, same folder position).

### 2.2 Backup creation on apply

1. Trigger at least one switch.
2. In Bookmarks Manager, locate:
  - `Other Bookmarks / BarPilot / Backups`

Expected:
- A new backup folder exists named like: `<timestamp> - <host>`
- It contains a full copy of your bookmarks bar state at the time.

### 2.3 Restore last backup

1. Switch to GitHub.
2. Switch to YouTube.
3. In popup, click **Restore last backup**.

Expected:
- Bar matches the previous backed-up state.

Notes:
- This restore replaces the entire bar content. That’s intentional for safety.

### 2.4 Trash behavior (old managed items)

1. Switch between two sites a couple times.
2. In Bookmarks Manager, locate:
  - `Other Bookmarks / BarPilot / Trash`

Expected:
- Trash contains timestamped folders with items that BarPilot moved out.

---

## Test group 3: “Don’t punish user edits”

### 3.1 Unknown items outside marker are untouched

1. Create a new bookmark on the bar **outside** `— BarPilot —`.
2. Switch sites a few times.

Expected:
- That bookmark is never moved/deleted.

### 3.2 User edits inside marker are not deleted automatically

1. Open `— BarPilot —`.
2. Add a new bookmark manually inside it.
3. Trigger a switch.

Expected:
- BarPilot should **only remove items it previously rendered**.
- The manually-added item should remain (unless you explicitly Reset).

### 3.3 Reset managed region

1. In popup, click **Reset managed region**.

Expected:
- `— BarPilot —` becomes empty.
- The removed items are moved into `Other Bookmarks / BarPilot / Trash / <timestamp> - reset`.

---

## Test group 4: Thrash control (debounce/dwell/min interval)

### 4.1 Rapid switching doesn’t churn endlessly

1. Rapidly click between GitHub and YouTube tabs for ~5 seconds.
2. Stop on GitHub tab.
3. Wait ~2 seconds.

Expected:
- BarPilot settles on the final tab’s set.
- It does not continuously rewrite after you stop.

### 4.2 Pause

1. Click **Pause 5m** in popup.
2. Switch between sites.

Expected:
- No automatic changes while paused.
- Popup diagnostics shows it’s paused.

---

## Test group 5: Modes

### 5.1 Automatic mode

Expected:
- Switching occurs per trigger policy.

### 5.2 Manual mode

1. Set Mode to **Manual** in popup.
2. Switch tabs.

Expected:
- No automatic switching.

Then:
1. Click **Re-render now**.

Expected:
- BarPilot applies once.

### 5.3 Local UI mode (no writes)

1. Set Mode to **Local UI (no writes)**.
2. Switch tabs.

Expected:
- Bookmarks bar does not change.
- Popup shows a preview list of what would be used.

---

## Test group 6: Trigger policy

### 6.1 Activation trigger

1. In popup or options: Trigger = **On tab activation**.
2. Click between GitHub and YouTube tabs.

Expected:
- Switch occurs on activation.

### 6.2 Navigation-only trigger

1. Trigger = **On navigation only**.
2. Click between tabs (without navigating).

Expected:
- No switch just from clicking.

Then:
1. In the active tab, navigate from `github.com` to another GitHub page (URL changes).

Expected:
- Switch occurs on navigation.

---

## Test group 7: Keyboard shortcuts

In `chrome://extensions/shortcuts`:

1. Confirm commands exist:
  - Toggle Lock
  - Toggle Enabled
  - Re-render now
2. Use the shortcut for Toggle Lock.

Expected:
- Lock flips, and automatic switching stops/starts accordingly.

---

## Test group 8: MV3 crash tolerance (hard mode)

### 8.1 Close Chrome mid-switch

This is the scary test.

1. Make a set with ~50 items (so apply takes long enough).
2. Trigger a switch to that set.
3. Immediately close Chrome (Alt+F4) while it’s working.
4. Re-open Chrome.

Expected:
- You do not lose canonical sets.
- BarPilot cleans up stale staging state.
- If the bar looks wrong: **Restore last backup** should recover.

### 8.2 Stale lock cleanup

Hard to force naturally; but you can still sanity-check:

Expected:
- After restart, BarPilot should not stay permanently “stuck” and unable to apply.

---

## Test group 9: Migration / legacy compatibility

BarPilot supports legacy root folder names (it will recognize `ContextBar` if it exists).

1. If you have an existing `Other Bookmarks / ContextBar / Sets`, leave it.
2. Ensure Options → list sets still works.

Expected:
- BarPilot can find/create its root and still validate sets under the chosen root.

---

## “Done” criteria (acceptance)

You can call this version “working” if:

1. Switching works reliably and feels stable (no constant churn).
2. Marker folder is created and used.
3. Pinned items remain untouched.
4. Canonical sets are not modified.
5. Backups are created and restore works.
6. Manual mode and Local UI mode behave as promised.
7. Crash test doesn’t lose bookmarks and recovery is possible.
