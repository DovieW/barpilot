# barpilot — Context-Switched Bookmarks Bar (Chrome Extension)

This is a **Manifest V3 Chrome extension** that automatically rewrites the **Bookmarks Bar** based on the **currently active tab’s host**.

It is designed to be:
- **Fast-feeling**: host changes are debounced/dwelled to avoid churn.
- **Safe**: canonical bookmark “sets” are never modified.
- **Recoverable**: every apply makes a real bookmarks backup + a JSON snapshot.

## How it works (plain-English)

You keep your “real” bookmark sets in a special folder in **Other Bookmarks**:

`Other Bookmarks / ContextBar / Sets / <SetName>`

When you switch sites (like GitHub → YouTube), the extension **copies** the chosen set onto the Bookmarks Bar. It only removes bookmarks that it previously created.

## Install (unpacked)

1. Open `chrome://extensions/`
2. Enable **Developer mode**
3. Click **Load unpacked**
4. Select this folder (`barpilot`)

## First-time setup

1. Open Chrome Bookmarks Manager.
2. Create your sets under:
	 - `Other Bookmarks / ContextBar / Sets / Work`
	 - `Other Bookmarks / ContextBar / Sets / Play`
	 - etc.
3. Use the extension popup to:
	 - set **Pinned count** (leftmost items on the bar that are never touched)
	 - pick a **Default set**
	 - optionally add **Host → Set** rules

## Safety notes

- The extension **never edits your Sets folders**.
- Before changing the bar, it creates a backup folder under:
	`Other Bookmarks / ContextBar / Backups / <timestamp> - <host>`
- Old managed items are moved to:
	`Other Bookmarks / ContextBar / Trash / <timestamp>`

