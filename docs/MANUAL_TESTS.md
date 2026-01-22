# Manual test checklist

These are quick “does this feel safe?” checks you can run before shipping a build.

## Setup

1. Install unpacked from this repo.
2. In Bookmarks Manager, create:
   - `Other Bookmarks / BarPilot / Sets / GitHub`
   - `Other Bookmarks / BarPilot / Sets / YouTube`
   - Put ~5–15 items in each.
3. In BarPilot **Options**, create rules:
   - `github.com` → `GitHub`
   - `youtube.com` → `YouTube`
   - Default set: pick one
4. Put 1–3 “pinned” items on the far left of your Bookmarks Bar.

## Core behavior

- Switching between GitHub and YouTube tabs updates within ~1–2 seconds.
- Pinned items remain untouched.
- BarPilot creates/uses the marker folder on the bar: `— BarPilot —`.
- User-created bookmarks outside the marker are not moved or deleted.

## Thrash control

- Rapid tab switching does not cause continuous churn.
- Use **Pause 5m** in the popup; confirm no automatic switching happens during pause.

## Safety / recovery

- After a switch, confirm a backup appears under:
  - `Other Bookmarks / BarPilot / Backups / <timestamp> - <host>`
- Use **Restore last backup**; confirm the bar returns to previous state.

## Manual edits are respected

- Add a bookmark outside `— BarPilot —` and confirm it remains across switches.
- Add a bookmark inside `— BarPilot —` and confirm:
  - it is NOT deleted on the next switch (BarPilot only removes items it previously rendered)
  - using **Reset managed region** clears the marker folder (moves items to Trash)

## Modes

- **Manual mode**: no automatic switching, but **Re-render now** works.
- **Local UI mode**: popup shows a preview list; no changes are written to bookmarks.
