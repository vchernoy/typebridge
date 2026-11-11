# Recovery interruption evidence (#37)

These tests distinguish request success, transaction completion, renderer termination and whole-browser termination. They do not establish power-loss durability or universal device behavior. See the [research record](https://github.com/vchernoy/typebridge/issues/37#issuecomment-6795367921).

## Automated coverage

| Scenario | Test | Scope |
|---|---|---|
| Abort a real transaction after its put request succeeds | `e2e/indexeddb.spec.ts`: direct commit and normal save helper | Runs in Chromium, Firefox and WebKit; previous text, title, history and revision must remain unchanged and the commit must reject |
| Renderer crash with an uncommitted journal | `e2e/recovery-crash.spec.ts`, Autosave on | Chromium CDP only; crash event required, unload markers absent, original retained, explicit recovery creates a separate copy with exact Unicode text/title |
| Renderer crash with private edits | Same spec, Autosave off | Chromium only; no journal before or after crash, committed original retained |
| Injected save/quota/cleanup failures and graceful reload/close | `e2e/recovery.spec.ts` | Portable three-browser tests; distinct from process crash |

Run the focused suite:

```sh
npx playwright test e2e/indexeddb.spec.ts e2e/recovery.spec.ts e2e/recovery-crash.spec.ts --project=chromium
```

The renderer cases explicitly skip Firefox/WebKit because `Page.crash` uses Chromium CDP. Portable recovery and transaction-abort cases still run in all three required CI jobs. A skipped renderer case is not evidence of renderer-crash recovery in that engine. Actual run outcomes belong in the PR/Actions record; listing a test here does not claim a particular run passed.

## Whole-browser process research: remaining gap

Local exploratory probes used Linux, Playwright 1.64.1, Chrome for Testing 156.0.8078.4 and the #239 runtime (`08e2a52`, merged as `2cf67cf`). A fresh test-owned browser process used a unique persistent profile. After a saved original, document writes were forced to fail, new Unicode text/title were entered, and the emergency journal was confirmed readable in the current page. The isolated test-owned process group was killed with SIGKILL, without calling context/browser close, then a new process opened the same profile.

- At **1 second** after observing journal availability/save failure, **two attempts** reopened the original committed text but had **zero journal entries** and no recovery button. Unload markers were absent.
- At **6 seconds**, **one attempt** retained one journal and recovered the exact text/title as a separate copy; the original stayed unchanged. Unload markers were absent.

These timings are observations, not a guaranteed flush boundary or suggested delay. The browser-process test is not part of R2a CI: it demonstrated a real remaining recovery gap and needs a diagnostic harness with explicit phase/result reporting. Do not turn it into a passing test by waiting arbitrarily for localStorage to reach disk. A successful synchronous localStorage write does not prove whole-browser crash durability. This experiment is not an OS/power-loss test.

Next research/implementation: repeat process-kill phases with owned-process/profile cleanup, browser versions and journal presence before/after restart; include Autosave-off controls. Evaluate a separately persisted emergency journal and transaction/durability behavior under contention and quota before making runtime changes. Preserve typing performance, privacy, exact-version cleanup and recover-as-copy. Retained version history remains a separate design stage.

## Not verified by this slice

Whole-browser crash durability at arbitrary times, Firefox/WebKit renderer/process crashes, OS/power failure, real iPhone/Safari background discard, real storage eviction/pressure, and real assistive technology. Existing user-reported offline reload/Undo observations in #37 remain separate evidence.
