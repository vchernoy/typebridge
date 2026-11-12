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

These timings are observations, not a guaranteed flush boundary or suggested delay. The exploratory browser-process test was not part of R2a CI: it demonstrated a real remaining recovery gap. The opt-in R2b diagnostic harness below now provides explicit phase/result reporting. Do not turn it into a passing test by waiting arbitrarily for localStorage to reach disk. A successful synchronous localStorage write does not prove whole-browser crash durability. This experiment is not an OS/power-loss test.

Delivered by R2b (#241, below): process-kill phases with owned-process/profile cleanup, browser versions, journal presence before/after restart and Autosave-off controls. Next (R2c): evaluate a separately persisted emergency journal and transaction/durability behavior under contention and quota before making runtime changes. Preserve typing performance, privacy, exact-version cleanup and recover-as-copy. Retained version history remains a separate design stage.

## Not verified by this slice

Whole-browser crash durability at arbitrary times, Firefox/WebKit renderer/process crashes, OS/power failure, real iPhone/Safari background discard, real storage eviction/pressure, and real assistive technology. Existing user-reported offline reload/Undo observations in #37 remain separate evidence.

## R2b: opt-in whole-browser diagnostic matrix

```sh
npx playwright test --config=playwright.diagnostics.config.ts
```

Linux and installed Playwright Chromium are required. This separate configuration runs only `e2e/process-crash.diagnostic.ts`, sequentially with no retries, two fresh-profile attempts per combination of Autosave on/off and 0/1000/6000 ms sampled delay. The default required quality and Chromium/Firefox/WebKit workflows remain unchanged. To narrow a run, use Playwright's `--grep`, for example `--grep 'delay=0ms'`.

Each attempt creates its own detached Chromium process group and unique temporary profile, saves an original, blocks subsequent document writes, enters synthetic Unicode edits, and observes the in-page journal count. Autosave-on timing starts after save failure and a readable journal; Autosave-off timing starts after private edits and a zero journal count. The requested delay starts at that observation, not at a disk flush or keystroke; actual elapsed milliseconds are also reported. It kills only the PID group returned by its own spawn, waits for exit, removes the stale DevTools endpoint, and starts a fresh browser process on the same profile. Cleanup kills and waits for the restarted process before deleting the profile, including on assertion failures.

Every attempt emits a `PROCESS_CRASH_EVIDENCE` JSON line and a Playwright JSON attachment with browser/Node versions, platform, phase, repeat, requested/actual delay, stage, journal counts and outcome. No document text/title or profile path is included. The stage and `incomplete` outcome distinguish harness/assertion failures from measured journal loss. Synthetic inputs are verified in memory; there is no telemetry or application storage behavior change.

The harness always requires the original committed text to survive, no unload marker on restart, and no recovery journal/copy for Autosave-off. If an Autosave-on journal survives, exact text/title must recover as a separate copy while the original stays unchanged. If it disappears, the harness records **`journal-lost-original-retained`** rather than retrying or increasing a delay until recovery succeeds. Thus a green diagnostic run means the experiment completed with its safety/privacy assertions intact; **it does not mean crash durability passed**. Inspect each outcome. This is deliberately not a production durability gate. No absence of a marker alone proves lifecycle behavior: the abrupt termination is established by the owned-process SIGKILL.

The delay matrix samples browser behavior; no delay is a guaranteed durability threshold or a proposed fix. These are Linux Chromium process-kill diagnostics, not renderer-only, other-browser, real-device, OS-crash or power-loss evidence. R2c still needs an evaluated persistence design and before/after results from the same harness; retained version history remains separate.

### Recorded baseline

[Machine-readable baseline](process-crash-baseline.json): local Linux, Playwright 1.64.1, Chromium 156.0.8078.4, Node 24.22.1, application commit `5d4d078` (no runtime changes in R2b). All 12 diagnostic attempts completed. Both Autosave-on attempts lost the journal at 0 ms, both lost it at 1000 ms, and both recovered an exact copy at 6000 ms. All six Autosave-off controls retained no journal/recovery copy. Saved original text survived every attempt. This small sample is a repeatable baseline for R2c, not a universal timing boundary or a durability guarantee.
