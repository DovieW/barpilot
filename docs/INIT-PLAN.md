# Context-Switched Bookmarks Bar (Chrome Extension) — Robust Implementation Plan

## Goal
Automatically replace the Chrome **Bookmarks Bar** contents based on the **currently active tab’s site** (host/domain), in a way that is:
- **Instant-feeling** (sub-second perceived latency)
- **Non-thrashy** (debounce/dwell/rate limit)
- **Extremely safe** (cannot lose canonical bookmarks; supports rollback and recovery)
- **Dependency-free** (plain Chrome Extension APIs; no build step; MV3)

Non-goals:
- Per-window independent bookmark bars (Bookmarks Bar is global in Chrome).
- Complex wildcard matching engine beyond basic patterns (can be added later).

---

## High-level Design (Safety First)
### Canonical source of truth
- Create a folder tree that the extension treats as immutable:
  - `Other Bookmarks / ContextBar / Sets / <SetName>`
  - Each `<SetName>` folder contains the bookmarks/folders you want to appear on the bar for that context.

### The Bookmarks Bar is a projection
- The extension never “moves” canonical bookmarks.
- On each switch, the extension **rebuilds** the bar using **generated copies** of the canonical folder contents.
- The extension only deletes or moves items that it created.

### Optional pinned items
- Reserve the first `PINNED_COUNT` items on the bar as untouched “pinned.”
- Everything after that is managed by the extension.

---

## UX / Configuration
### Domain → Set mapping
- Maintain a rules table in extension storage:
  - `rules: [{ matchType, pattern, setId }, ...]`
  - `matchType`: `hostEquals` | `hostSuffix` | `regex` (optional) | `default`
  - `pattern`: string
  - `setId`: bookmarks folder ID for `ContextBar / Sets / <SetName>`

### Controls
- Extension action popup:
  - Toggle: `Enabled`
  - Toggle: `Lock (freeze bar)`
  - Dropdown: `Default set`
  - Button: `Open ContextBar folders`
  - Button: `Restore last backup`
  - Button: `Re-render now`

---

## Robustness Requirements
### Hard safety guarantees
1. **Canonical folders are never modified.**
2. **Only extension-created bookmarks are ever deleted/moved.**
3. Every switch is recoverable using:
   - Snapshot of prior bar state (JSON in storage)
   - Backup folder (real bookmarks) created before modifications

### Crash tolerance
- Use a staging folder and a two-phase swap.
- On startup, detect and clean up any orphan staging folder.

### Thrash control
- Debounce host changes (e.g., 300–800ms).
- Dwell time on active host (e.g., 600–1200ms).
- Rate limit switches (e.g., no more than once per 1500ms).
- Queue only the latest pending request while a render is running.

---

## Permissions / Manifest (MV3)
### Manifest essentials (no build tools)
- `manifest_version: 3`
- Permissions:
  - `bookmarks`
  - `tabs`
  - `storage`
  - `alarms` (optional; for delayed cleanup, periodic verify)
- Host permissions:
  - not strictly required for reading tab URLs via `tabs` (but some cases may require `activeTab` or proper permissions)
- Background: `service_worker: background.js`
- Action: `default_popup: popup.html`

Notes:
- Keep everything plain JS/HTML/CSS.
- No bundlers, no npm, no compilation.

---

## Data Model (chrome.storage.local)
### Core keys
- `enabled: boolean`
- `locked: boolean`
- `pinnedCount: number`
- `rules: Rule[]`
- `defaultSetId: string | null`
- `lastAppliedHost: string | null`
- `lastApplyAt: number (ms epoch)`
- `inProgress: { opId, startedAt } | null`
- `pendingHost: string | null`

### Generated items tracking
- `managed: { lastRenderedIds: string[], lastStagingFolderId?: string }`

### Recovery
- `snapshots: Snapshot[]` (ring buffer, e.g., 20)
- `lastBackupFolderId: string | null`

Types:
- `Rule = { matchType: string, pattern: string, setId: string }`
- `Snapshot = { ts, host, pinnedCount, barTree: NodeDTO }`
- `NodeDTO = { title, url?, children?[] }` (no IDs; pure structure)

---

## Matching Logic (Domain Selection)
### Normalize host
- Use `new URL(tab.url).hostname` for http(s).
- Ignore non-web URLs:
  - `chrome://`, `edge://`, `about:blank`, `file://`, `chrome-extension://`, etc.
- For ignored URLs, either:
  - apply `defaultSetId`, or
  - do nothing (configurable).

### Rule resolution (deterministic)
Priority order:
1. `hostEquals` exact match (e.g., `youtube.com`)
2. `hostSuffix` (e.g., `.google.com` matches `docs.google.com`)
3. `regex` (optional advanced)
4. fallback `defaultSetId`

---

## Switching State Machine
### Events that can trigger a candidate switch
- `tabs.onActivated`
- `tabs.onUpdated` (only when URL changes, not every status update)
- Optionally `windows.onFocusChanged` (to track focused window)

### Debounce / dwell / rate limit
Implementation approach:
- Maintain `candidateHost` and `candidateSince`.
- On each relevant event:
  1. Compute host.
  2. If host changed: set candidate, record time, start/update a timer.
- Timer fires after debounce interval:
  - Check if candidateHost is still active (re-read active tab).
  - Check dwell time and rate limit.
  - If allowed: call `applyHost(candidateHost)`.

### Concurrency / locking
- `applyHost()` must acquire a mutex:
  - If `inProgress != null`, just update `pendingHost` and return.
  - Otherwise set `inProgress` with an `opId`.
- When render completes:
  - Clear `inProgress`.
  - If `pendingHost != null` and differs from current: apply again.

---

## Render Algorithm (Two-Phase, Non-destructive)

### Terminology
- `BAR_ROOT_ID`: Chrome’s bookmarks bar node ID (typically `"1"` but do not hardcode; discover by querying tree).
- `PINNED_COUNT`: first N children under bar root untouched.
- `MANAGED_REGION`: bar children indices >= PINNED_COUNT

### Phase 0 — Preflight
1. Check `enabled && !locked`.
2. Resolve target `setId` for host.
3. If `setId` is null: exit.
4. Acquire mutex and ensure `opId` current.
5. Discover `barRootId`.
6. Validate `setId` exists and is under `ContextBar / Sets`.

### Phase 1 — Snapshot + Backup
1. Create JSON snapshot of current bar state:
   - Read bar subtree.
   - Store in ring buffer.
2. Create a bookmarks backup folder:
   - `Other Bookmarks / ContextBar / Backups / <ISO timestamp> - <host>`
   - Copy current bar children into backup folder (including pinned).
   - Store backup folder ID as `lastBackupFolderId`.

### Phase 2 — Build staging in the bar
1. Create `__ContextBarStaging` folder under the bar root.
2. Copy contents of `setId` into the staging folder:
   - Preserve hierarchy.
   - Preserve order.
   - Use async recursion for folders.
3. Record staging folder ID in storage (`managed.lastStagingFolderId`).

### Phase 3 — Swap (atomic-ish)
1. Identify current managed children:
   - Read bar children.
   - Keep indices `[0..PINNED_COUNT-1]` as pinned.
   - For indices >= pinned:
     - If ID in `managed.lastRenderedIds`, eligible for deletion/move.
     - If unknown ID, do **not** touch (defensive).
2. Remove old managed items:
   - SAFEST mode: move them to `Other Bookmarks / ContextBar / Trash / <timestamp>`
   - Alternative: delete them (only if created by extension).
3. Move staging children into bar root at position PINNED_COUNT (or append in order).
4. Delete staging folder.

### Phase 4 — Record state
1. Persist new `managed.lastRenderedIds` (IDs of the newly created/moved managed items).
2. Set `lastAppliedHost` and `lastApplyAt`.

### Phase 5 — Verify and rollback if needed
Verification checks:
- Count of top-level managed items equals count of top-level items in target set.
- Titles match in order (URLs match for leaf nodes).
- Optionally: shallow-verify one level deep.

If verification fails:
- Roll back using latest snapshot or backup folder:
  - Clear managed region.
  - Restore from backup folder or snapshot DTO.

---

## Bookmark Copying Details
### Copy semantics
- A bookmark node is copied as:
  - If `url` exists: `chrome.bookmarks.create({ parentId, title, url })`
  - If folder: `chrome.bookmarks.create({ parentId, title })` then recurse children

### Ordering
- Chrome `bookmarks.create` appends; to preserve order, create children sequentially.
- If needed, use `chrome.bookmarks.move` with `index` to enforce order.

### Performance expectations
- Small-to-medium sets (10–60 items) should complete quickly.
- For very large sets, you may need:
  - a progress state
  - stricter rate limiting
  - optional “max items” warning

---

## Cleanup and Recovery
### Startup cleanup
On service worker startup:
- If `managed.lastStagingFolderId` exists:
  - If folder still present, delete it (or move to Trash).
- If `inProgress` exists and is stale (older than e.g. 30s):
  - Clear `inProgress`, allow new renders.

### Restore actions
- “Restore last backup”:
  - Replace bar root children with those in `lastBackupFolderId`.
- “Restore from snapshot”:
  - Rebuild bar from stored `NodeDTO`.

---

## Edge Cases / Defensive Rules
- If active tab has unsupported URL scheme:
  - apply default set or do nothing (configurable).
- If user edits the managed region manually:
  - extension should not delete unknown IDs.
  - Provide “Reset managed region” action.
- If rules reference a missing set folder:
  - fall back to default.
- If Bookmark Sync is enabled:
  - Frequent writes may sync to other devices; document this in README and provide a “manual-only” mode toggle.

---

## Implementation Structure (No build step)
### Files (suggested)
- `manifest.json`
- `background.js` (service worker; core state machine and rendering)
- `popup.html`, `popup.js`, `popup.css` (controls and diagnostics)
- `options.html`, `options.js` (rule editor; optional)
- `utils.js` (URL parsing, debounce, storage helpers; optional)

Keep it simple: plain JS modules if desired, but can also be a single file.

---

## Key Functions (Pseudo-interfaces)
### Background
- `getActiveHost(): Promise<string|null>`
- `resolveSetIdForHost(host): Promise<string|null>`
- `scheduleCandidateSwitch(host): void`
- `applyHost(host): Promise<void>` (mutexed)
- `snapshotBar(host): Promise<void>`
- `backupBar(host): Promise<string>` (returns backup folder ID)
- `renderSetToBar(setId, pinnedCount): Promise<string[]>` (returns rendered IDs)
- `verifyRender(setId, renderedIds): Promise<boolean>`
- `rollback(): Promise<void>`

### Bookmarks utility
- `findOrCreateFolder(pathParts, rootId): Promise<string>`
- `copySubtree(srcId, dstParentId): Promise<string[]>` (returns created node IDs)
- `readSubtreeAsDTO(rootId): Promise<NodeDTO>`
- `rebuildSubtreeFromDTO(dto, dstParentId): Promise<string[]>`

---

## Operational Defaults (Recommended)
- `enabled = true`
- `locked = false`
- `pinnedCount = 3` (configurable)
- `debounceMs = 500`
- `dwellMs = 800`
- `minIntervalMs = 1500`
- deletion policy: move to Trash (not delete)

---

## Acceptance Tests (What “done” means)
1. Switching between `youtube.com` and `github.com` updates bar within ~1s without thrashing.
2. Pinned items remain untouched across switches.
3. If Chrome is closed mid-switch, on restart:
   - bar is either unchanged or recoverable; no loss of canonical folders.
4. Manual user edits in managed region are not destroyed (unknown IDs not touched).
5. “Restore last backup” returns bar to previous state.
6. Repeated rapid tab switching does not cause continuous bookmark churn.

---

## Notes for the Coding Agent
- MV3 service worker can be suspended; keep state in `chrome.storage.local`.
- Bookmark operations are async and event-driven; implement strict sequencing and locking.
- Prefer correctness and safety over micro-optimizations.
- Do not hardcode bar root ID; discover it via `chrome.bookmarks.getTree()`.
