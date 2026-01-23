# Refactor / Next Improvements

This file is intentionally a parking lot for “good ideas” that are **out of scope** for the initial working version.

## UX / configuration

- (DONE) Add an `options.html` rule editor (CRUD for rules, hostSuffix + regex) + dry-run preview.
- Add a “Default behavior for non-web URLs” setting:
  - do nothing vs apply default set.
- (DONE) Add a small diagnostics panel (last applied host, last error).

## Safety / robustness

- (DONE) Improve bar/other root discovery (prefer known IDs when available; fallback safely).
- Make rollback smarter:
  - restore only managed region during auto-rollback (leave pinned untouched).
- (DONE) Add an explicit “Reset managed region” action.
- Add a “dry-run verify” mode and more detailed verification (1-level deep, counts).
- Consider adjusting `cleanupStaleState()` fallback staging-folder cleanup:
  - It currently scans children of the bookmarks bar root for `__BarPilotStaging …`.
  - Staging folders are created under the marker folder, so the fallback scan may be looking in the wrong place.

## Performance / thrash

- Expose debounce/dwell/minInterval as user settings.
- Add an “apply queue” that collapses rapidly changing hosts more aggressively.

## Dev hygiene

- Add a small test harness / manual test checklist in `docs/`.
- Add basic CI (linting) if we later introduce a build step (currently we don’t).
