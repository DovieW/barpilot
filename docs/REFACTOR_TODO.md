# Refactor / Next Improvements

This file is intentionally a parking lot for “good ideas” that are **out of scope** for the initial working version.

## UX / configuration

- Add an `options.html` rule editor (CRUD for rules, ordering/priority, hostSuffix + regex).
- Add a “Default behavior for non-web URLs” setting:
  - do nothing vs apply default set.
- Add a small diagnostics panel (last applied host, last apply time, last error).

## Safety / robustness

- Improve bar/other root discovery (avoid assuming `getTree()[0].children[0/1]`).
- Make rollback smarter:
  - restore only managed region during auto-rollback (leave pinned untouched).
- Add an explicit “Reset managed region” action.
- Add a “dry-run verify” mode and more detailed verification (1-level deep, counts).

## Performance / thrash

- Expose debounce/dwell/minInterval as user settings.
- Add an “apply queue” that collapses rapidly changing hosts more aggressively.

## Dev hygiene

- Add a small test harness / manual test checklist in `docs/`.
- Add basic CI (linting) if we later introduce a build step (currently we don’t).
