# APP_REVIEW.md — BarPilot (foot-gun review)

This is a **practical “foot-gun” review** of this repo’s setup and defaults. It’s intentionally not deep architecture work—just common misconfigurations / unsafe defaults / reliability gaps that are usually easy to fix.

Date reviewed: 2026-01-22

---

## First-pass inventory

### Tech stack

- **Chrome extension (Manifest V3)**
  - Background: MV3 **service worker** `background.js` (entrypoint)
  - UI: `popup.html`/`popup.js`, `options.html`/`options.js`
  - Styling: `popup.css`, `options.css`
- Language: **plain JavaScript + HTML + CSS**
- Storage: **`chrome.storage.local`** for extension state and snapshots
- External services / DB / queues: **none found**
- Dependencies: **none** (no `package.json`, no lockfiles)

### How the app is started (dev + “prod”)

- Dev install is “load unpacked”:
  - See `README.md` → **Installation (Developer mode)**.
- “Prod” is essentially:
  - zip and publish to Chrome Web Store (not present in repo)
  - no container/deploy scripts (expected for an extension)

### Entrypoints and readiness (mental run)

- Chrome loads the extension and starts the MV3 background worker `background.js`:
  - On install (`chrome.runtime.onInstalled`), it writes default config keys.
  - On browser startup (`chrome.runtime.onStartup`), it:
    - runs `cleanupStaleState()`
    - reads the active tab host and may schedule an apply.
- User-visible controls are via:
  - Action popup (`popup.html` + `popup.js`)
  - Options page (`options.html` + `options.js`)

“Readiness” concept is basically “extension loads without errors and can read bookmarks/tabs.” There’s no HTTP server, ports, health checks, etc.

---

## Top 5 risks (most likely foot-guns)

1. **Writes to bookmarks by default (auto-enabled + automatic mode)**
2. **Options page likely runs conflicting/legacy code (runtime errors)**
3. **Restore operation wipes the entire bookmarks bar (including pinned)**
4. **Snapshots store full bookmarks bar URLs in `chrome.storage.local`**
5. **Backups/Trash can grow without bounds (no retention/cleanup)**

## Top 5 quick wins (small fixes that reduce risk fast)

1. Default to **Locked** or **Manual** (or `enabled: false`) on first install; require explicit opt-in.
2. Remove the duplicated/legacy script chunk in `options.js` (it doesn’t match `options.html`).
3. Add a “Restore last backup” confirmation that clearly states it restores the **entire** bar.
4. Add a “Clear snapshots / Clear backups / Clear trash” button + basic retention policy.
5. Add a minimal CI check (even just “load extension files + run a linter”) to prevent shipping broken UI JS.

---

## How to run (simplest dev bootstrap)

From `README.md`:

1. Clone the repo.
2. Open Chrome → `chrome://extensions`.
3. Enable **Developer mode**.
4. Click **Load unpacked** → select the repo folder.
5. Create bookmark folders under:
   - `Other Bookmarks / BarPilot / Sets / <SetName>`
6. Configure rules and defaults in **Options**.

Missing / could be clearer:

- There’s no “smoke test” script that checks for obvious runtime errors in `popup.js`/`options.js`.
- There’s no “packaging” checklist (zip creation, version bump steps, store release notes).

---

## Findings table

| Title | Severity | Evidence | Why it’s a foot-gun (plain language) | Minimal fix recommendation |
|---|---:|---|---|---|
| Auto-enabled and automatic by default | **High** | `background.js:41` `enabled: true` ; `background.js:43` `mode: 'automatic'` | A new install can start modifying the user’s bookmarks bar without them explicitly choosing “yes, do writes.” If they have bookmark sync, this can also ripple to other devices. | On first install set safer defaults: `enabled: false` **or** `locked: true` **or** `mode: 'manual'`. Then show a first-run explanation in popup/options. |
| Options page contains a second, legacy script block | **High** | `options.js:196-197` references `saveStatus`; `options.js:256-257` references `switchPolicy` / `nonWebBehavior`; second `DOMContentLoaded` at `options.js:320` | `options.html` does not have elements like `saveStatus`, `switchPolicy`, `nonWeb`, etc. That means the Options page can throw errors in the console and/or break parts of the UI. This is a reliability foot-gun (users can’t configure safely). | Delete the legacy/duplicated code chunk (everything after the “real” Options implementation), or split into separate files and only include one in `options.html`. Add a quick manual smoke test: open Options and ensure no console errors. |
| Restore last backup removes **all** bar children (including pinned) | **Med** | `background.js:416` `restoreFromBackup(...)`; `background.js:420` loops through `barChildren` and `bookmarksRemoveTree(c.id)` | Users may assume “restore” only affects BarPilot-managed items. This implementation wipes the entire bookmarks bar then rebuilds from backup. It’s safe-ish (because it’s a restore), but it can surprise people and remove pinned items they expected to stay. | Add a confirmation dialog in popup/options: “This restores the entire bookmarks bar (including pinned). Continue?” Longer term: implement a “restore managed region only” option. |
| Snapshots store URLs/titles of the full bookmarks bar in extension storage | **Med** | `background.js:94` uses `chrome.storage.local.get`; `background.js:358` `dto.url = root.url`; `background.js:401` stores `barTree: barDto`; `background.js:63` keeps up to 20 snapshots | Snapshots can contain sensitive URLs and folder names (banking, internal tools). They live in `chrome.storage.local`. If the extension is compromised later, stored snapshots are extra data to steal. Also, storing full bar trees can increase storage usage over time. | Make snapshots optional (toggle), or store only the managed region instead of the whole bar. Add a “Clear snapshots” button. Consider storing only minimal metadata needed for recovery (or rely on bookmark-folder backups only). |
| Backups and Trash can grow without a cleanup/retention policy | **Med** | Backups/Trash are created by design: `README.md` “Backups” + “Trash”; `background.js` creates timestamped folders (e.g. `backupBar(...)` creates in Backups; old managed items moved into Trash) | Frequent switching can create lots of backup folders and trash buckets. Over time this becomes clutter and can slow bookmark operations. Users may not notice until it’s messy. | Add a simple retention policy (e.g., keep last N backups/trash entries) and a UI button to clean old ones. Optionally use `alarms` for periodic cleanup (with a safe default like “keep last 20”). |
| User-supplied regex matching can cause slowdowns | **Low/Med** | `background.js` `ruleMatchesHost(...)` uses `new RegExp(rule.pattern)` (seen in source) | If a user enters a “bad” regex, it could be extremely slow (catastrophic backtracking). It’s only run against hostnames (short strings), so risk is limited, but it can still cause UI jank or missed switching. | Limit regex length, pre-validate regex on save, and/or add a warning in Options. Consider caching compiled regex objects. |
| No CI checks for basic regressions | **Low/Med** | Repo has no `.github/workflows/*` (none found in root listing) | A simple accidental edit (like the `options.js` duplication) can ship unnoticed. CI would catch “Options page throws” or at least lint failures. | Add a minimal GitHub Actions workflow: run a linter (or even a lightweight node script that loads/parses the JS and checks required DOM IDs match the HTML). |
| Permissions are high-impact (bookmarks + tabs) and deserve extra guardrails | **Low** | `manifest.json:6` `"permissions": ["bookmarks", "tabs", "storage", "alarms"]` | This is expected for functionality, but it means any bug has a big blast radius (bookmarks writes). Users and reviewers will also be extra sensitive to safety and clarity. | Keep the strong safety messaging. Consider extra “are you sure?” prompts for destructive actions, and ship safer defaults (locked/manual) to match the permission level. |

---

## Quick-win patch list (small changes to remove risk fast)

1. **Fix Options runtime**: remove legacy/duplicate code in `options.js` so `options.html` runs a single consistent implementation.
2. **Safer first-run defaults**:
   - set `enabled: false` OR `locked: true` OR `mode: 'manual'` on install
   - show a first-run checklist (create sets folder, set default set, understand sync warning)
3. **Confirm destructive-ish actions**:
   - “Restore last backup” confirmation (and say it affects pinned)
   - “Reset managed region” confirmation (less critical, but still helpful)
4. **Add cleanup UX**:
   - “Clear snapshots”
   - “Prune backups/trash older than N days” (or keep last N)
5. **Add minimal CI**:
   - lint JS (or just run a syntax check)
   - optional: basic DOM ID sanity check between `options.html` and `options.js`

---

## Nice to have later (non-blocking)

- Add a “backup retention” setting + scheduled cleanup.
- Provide a “managed-region-only restore” option to keep pinned items intact.
- Provide a one-click “Export diagnostic report” (local-only text) for troubleshooting.
- Add a packaging/release checklist for Chrome Web Store (version bump, zip, screenshots, permissions rationale).
