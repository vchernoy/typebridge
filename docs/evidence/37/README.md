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

## R2c step 1: does a reported write survive a whole-browser kill?

Measurement only; the application is unchanged. `e2e/storage-durability.diagnostic.ts` runs with the same opt-in configuration as R2b (`npx playwright test --config=playwright.diagnostics.config.ts`, which now runs both files; narrow with `--grep 'R2c'`). Each attempt uses its own Chromium process and profile (shared helper `e2e/owned-chromium.ts`), writes synthetic text on the reading page (which opens no application storage) into a separate spike database or `localStorage` key, waits until the browser **reports success** (`setItem` returned; transaction `complete`), then kills about 0 or 1000 ms after that moment (the expected hash is computed before the write, and the recorded delay runs from the reported success to the kill; "0 ms" was 2–5 ms in practice), SIGKILLs the process group, restarts on the same profile and compares a hash and length. Append cases issue 200 one-record transactions back to back, like keystrokes, and require 1..200 all present. Set `DIAGNOSTIC_CHROMIUM` to another installed Chromium when Playwright's own build is absent.

[Machine-readable result](storage-durability-r2c.json): local Linux, Playwright 1.64.1, Chromium 153.0.8010.12, Node 22.22.0; 2 attempts per case.

| Write | Size (characters) | Kill 0 ms after success | Kill 1000 ms after success |
|---|---|---|---|
| `localStorage.setItem` | 2,000 | lost 2/2 | lost 2/2 |
| `localStorage.setItem` | 1,000,000 | lost 2/2 | lost 2/2 |
| IndexedDB put, default durability | 2,000 | survived exactly 2/2 | survived exactly 2/2 |
| IndexedDB put, default durability | 5,000,000 | survived exactly 2/2 | survived exactly 2/2 |
| IndexedDB put, `strict` durability | 2,000 | survived exactly 2/2 | survived exactly 2/2 |
| IndexedDB put, `strict` durability | 5,000,000 | survived exactly 2/2 | survived exactly 2/2 |
| 200 IndexedDB appends | one small record each | all 200, no gap, 2/2 | all 200, no gap, 2/2 |

A 5,000,000-character put took about 75–220 ms from issue to reported completion; 200 appends took about 45–115 ms together.

Cost of one write until it reports success (median of 7, same browser):

| Document size | Today's journal: whole text as JSON to `localStorage` | Today's Autosave: whole record to IndexedDB | Proposed: one change record to IndexedDB |
|---|---|---|---|
| 100,000 | 3.5 ms | 3.3 ms | 0.4 ms |
| 1,000,000 | 17.8 ms | 15.8 ms | 0.6 ms |
| 10,000,000 | quota exceeded | 145 ms | 0.3 ms |

Cost and durability use the same owned browser launcher. An earlier run of the full diagnostic configuration also repeated the R2b matrix through the shared helper, with the same outcomes as the [R2b baseline](process-crash-baseline.json): the application's `localStorage` journal was lost at 0 and 1000 ms and recovered at 6000 ms; Autosave off never journaled; the saved original always survived.

**Reading.** In this harness and this Chromium, every IndexedDB write that had reported `complete` survived a whole-browser kill 2–5 ms or about 1 s later, including multi-megabyte records, and every returned `localStorage.setItem` was lost, even 1 s later. This is evidence from a small sample, not a guarantee. Strict durability made no observable difference for a process kill (it targets OS crash and power loss, which this does not test). A change record costs well under 1 ms regardless of document size, while full copies grow with the document. This supports building the [R2c design](https://github.com/vchernoy/typebridge/issues/37#issuecomment-6821462575): a change log in the existing IndexedDB database plus snapshots, replacing the `localStorage` journal. If that holds, the expected loss window becomes "changes whose transaction had not reported complete" instead of "everything since the last pause". The implementation must show this with its own before/after runs of the R2b harness, plus coverage for contention, quota, privacy and exact-version cleanup.

**Limits.** Linux Chromium process kill only: not Firefox/WebKit, real phones, OS crash or power loss. Two attempts per case is a small sample, not a guarantee. A write still in flight at the kill is not covered by "reported success" and can be lost.

## R2c step 2c: recovery from the change log after a whole-browser kill

`e2e/process-crash.diagnostic.ts` now also runs a change-log variant (`--grep 'change log'`). It kills the owned process the same way as R2b, but only **document** saves fail, so change-log records still reach storage. Recovery needs no click: when a window starts editing the document, the records another run left after the stored row are replayed and kept as a new document "<title> (recovered)" in one transaction with their removal (`salvageChanges`; a save of a new run does the same before it prunes). The diagnostic records whether the exact latest text is stored as a copy and the original row is unchanged.

[Machine-readable result](change-log-recovery-r2c.json): local Linux, Playwright 1.64.1, Chromium 153.0.8010.12, Node 22.22.0, 2 attempts per case, same run for both rows.

| Kill after the failed save | localStorage journal (R2b matrix) | Change log (this step) |
|---|---|---|
| 0 ms | lost 2/2 | **recovered exact copy 2/2** |
| 1000 ms | lost 2/2 | **recovered exact copy 2/2** |
| 6000 ms | recovered (after a click) 2/2 | **recovered exact copy 2/2** |

The saved original survived every attempt; Autosave-off controls still journaled nothing; no change records were left after recovery. At 1000 ms and later, Chromium restored the killed tab on restart (4 pages instead of 2): that tab opened the document first and made the copy, so the newly opened tab showed the recovered copy (the newest document) instead of the original. Both texts are stored either way.

**Reading.** In this harness and this Chromium, text whose change records were written survived a whole-browser kill even immediately after the failed save, where the localStorage journal did not. As of 2d-1 the copy also carries an unsaved title from the log. Linux Chromium process kill only, small sample, not OS crash, power loss or other engines; a record still in flight at the kill is not covered.

### R2c 2d-2: journal only as a fallback (re-run)

After gating the localStorage journal so it writes only when the change log cannot protect the latest edit, the same opt-in diagnostic was re-run locally (Linux, Playwright Chromium 156.0.8078.4, Node 22.23.4, `DIAGNOSTIC_CHROMIUM` = Playwright's Chromium build):

| Kill after the failed save | localStorage journal (R2b matrix) | Change log |
|---|---|---|
| 0 ms | lost 2/2 | recovered exact copy 2/2 |
| 1000 ms | lost 2/2 | recovered exact copy 2/2 |
| 6000 ms | recovered (after a click) 2/2 | recovered exact copy 2/2 |

Autosave-off controls still journaled nothing. Outcomes are no worse than [change-log-recovery-r2c.json](change-log-recovery-r2c.json). In the protected state after a committed save, normal typing no longer writes `typebridge.recovery.v1.*` keys (covered by `e2e/journal-fallback.spec.ts`).

**Discard changes and reload (#255):** after #254, close/switch discard clear change records under the fence; update-reload uses a durable `discardMarkers` row plus sessionStorage intent (`documentId` + optional exact journal snapshot) so `assert → location.reload()` stays synchronous. Applied on the next load before salvage; only the consented journal is cleared (not every same-document entry). Cancelled reloads clear intent first so stale markers never delete records. Covered by `e2e/update-notice.spec.ts` and IndexedDB marker tests in `e2e/indexeddb.spec.ts`.
