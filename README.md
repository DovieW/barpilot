# README.md

# BarPilot
**Per-site Bookmarks Bar profiles for Chrome.** BarPilot automatically switches your **Bookmarks Bar** based on the website you’re currently using—while keeping your original bookmark sets safe and recoverable.

## What BarPilot does
- Maintains multiple **bookmark bar “sets”** stored in folders you control.
- When you visit a site (e.g., `youtube.com`), BarPilot renders the matching set onto your Bookmarks Bar.
- Includes **backups and restore**, so you can recover easily if you ever dislike the result.

## How it stays safe
BarPilot is designed around a strict safety model:

- **Your sets are canonical**: BarPilot treats your set folders as immutable.
- The Bookmarks Bar is treated as a **projection**: BarPilot renders copies onto the bar.
- BarPilot only deletes/moves bookmarks that **it created**.
- Before switching, BarPilot creates a **backup folder** of the entire bar.

Optionally, BarPilot can move old rendered items into a **Trash** folder instead of deleting them.

BarPilot also keeps its changes inside a clearly labeled marker folder on your Bookmarks Bar:
- `— BarPilot —`

Anything outside that marker (including your pinned items) is left alone.

If you prefer not to have a folder on the bar, you can switch to **Render directly on the bookmarks bar** in Options.
In that mode, BarPilot will manage (move to Trash + replace) **everything after your pinned items**.

When you switch between render modes:
- Switching **to** direct-to-bar: BarPilot will remove the `— BarPilot —` marker folder from the bar (moved to Trash) and replace everything after your pinned items.
- Switching **back** to marker-folder mode: BarPilot restores a baseline backup (made when you first entered direct-to-bar mode) so your previous non-BarPilot bar items come back.

## Important note about Chrome Sync
If you use Chrome bookmark sync across multiple devices, BarPilot’s changes to the Bookmarks Bar may:
- sync to other devices, and
- cause flipping if different devices are focused on different sites.

BarPilot includes **Lock** and **Manual mode** to prevent this. If you sync across multiple devices, consider using Manual mode or keeping BarPilot locked most of the time.

---

## Installation (Developer mode)
BarPilot is dependency-free (no build step).

1. Clone or download this repository.
2. Open Chrome and navigate to `chrome://extensions`.
3. Enable **Developer mode**.
4. Click **Load unpacked** and select the repository folder.

---

## Setup
### 1) Create your BarPilot Sets
BarPilot expects sets to live under a dedicated folder in bookmarks, e.g.:

- `Other Bookmarks / BarPilot / Sets / YouTube`
- `Other Bookmarks / BarPilot / Sets / GitHub`
- `Other Bookmarks / BarPilot / Sets / Default`

Each set folder can contain:
- bookmarks
- subfolders
- nested structures

### 2) Map sites to sets
In BarPilot Options, create rules such as:
- `youtube.com` → `YouTube`
- `github.com` → `GitHub`
- default → `Default`

### 3) Choose pinned items (optional)
You can reserve the first N items on your Bookmarks Bar as “pinned.” BarPilot never touches those.

---

## Usage
### Controls (Action popup)
- **Enabled**: turn BarPilot on/off
- **Lock**: freeze the Bookmarks Bar (no automatic switching)
- **Re-render now**: rebuild the managed region from the current matching set
- **Restore last backup**: revert the Bookmarks Bar to the last saved backup

### Recommended modes
- **Automatic**: BarPilot switches for you (best for single-device use)
- **Manual**: only switches when you click a button/hotkey (best for multi-device sync)

---

## Permissions rationale
BarPilot requests minimal permissions required for its function:

- `bookmarks`: read/write the Bookmarks Bar and your BarPilot set folders
- `tabs`: identify the active tab’s URL to choose the right set
- `storage`: store rules, operational state, and snapshots
- `alarms` (optional): periodic cleanup of stale staging state and other safety tasks

BarPilot does **not** inject content scripts and does **not** read page content.

---

## Robustness / Implementation Notes
BarPilot uses:
- debounce + dwell time + minimum interval to prevent thrashing
- a staging folder for two-phase swaps (crash-tolerant)
- backups on every switch
- a strict “only touch what we created” policy

---

## Recovery
If something looks wrong:
1. Open BarPilot’s popup.
2. Click **Restore last backup**.
3. Optionally disable BarPilot or enable **Lock**.

Backups are stored as bookmark folders under:
- `Other Bookmarks / BarPilot / Backups / <timestamp>`

Trash (if enabled) is stored under:
- `Other Bookmarks / BarPilot / Trash / <timestamp>`

---

## Roadmap ideas
- Side panel “Local UI mode” (contextual bookmarks without rewriting the bar)
- Hotkey-driven switching
- Improved matching rules (wildcards / regex)
- Multi-profile and export/import of rules

---

## License
This project is licensed under the **GNU GPLv3**.

See `LICENSE`.
