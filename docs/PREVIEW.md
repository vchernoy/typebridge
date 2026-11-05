# Preview builds and production deployment

Pull requests run quality checks and Playwright in Chromium, Firefox and WebKit. They do not publish a preview or change production. To preview a branch locally, run `npm ci`, `npm run build`, and `npm run preview`, then open the URL it prints.

The historical PR #16 artifact-only workflow has been retired. A general hosted PR preview remains future work; do not use the production Pages environment for a PR-only artifact that could replace the live site. Any separate preview host needs a concrete design, permissions and cleanup policy first.

## Pages release gate

Pushes to main and manual dispatch on main run the reusable CI workflow (`ci.yml`) for the same event revision. It must pass lint, typecheck, unit tests, the production build and all three Playwright browser jobs. Its quality job uploads that production build as the Pages artifact, and deploy depends on the whole checks job, so a failed, cancelled or skipped check prevents deployment and the deployed `dist` is the one the checks built. The Playwright jobs build the same commit from the same lockfile. Each job has a 15-minute timeout, so a hung check cannot hold the Pages concurrency lock for hours. Manual dispatch from another branch is skipped; deploy also checks the branch itself.

The three Playwright jobs run inside the official `mcr.microsoft.com/playwright` container whose tag matches the locked `@playwright/test` version (#168), so browsers and their system libraries are preinstalled instead of downloaded with `playwright install --with-deps` on every run. A check step fails with a clear message if the dependency and the image tag drift apart; update both together. On a failing test the job uploads `test-results/` (traces) as a `playwright-traces-<browser>-<attempt>` artifact for seven days.

CI no longer has its own `push: main` trigger: on main the Pages gate is the single CI run for each revision. Pull requests and manual dispatch still run CI directly.

Permissions remain read-only except for the deploy job's Pages write and OIDC token. Existing Pages concurrency and environment protections are retained. A workflow PR cannot prove the production gate by publishing: review the job graph, validate with actionlint, and observe the first authorized main deployment after merge.

## Manual browser checks

Run on iPhone Safari and iPhone Chrome (both use WebKit on iOS), plus desktop Chrome, Firefox and Safari. Record browser/OS version, keyboard/language, steps and expected versus actual results in the pull request or issue being tested. Do not enter sensitive text in a public deployment.

- Type `privet`, `shchuka`, `yozh`; check the output and caret, then type in the middle of existing text.
- Select a range and replace it; use Backspace and Delete around Cyrillic, punctuation and emoji.
- Toggle transliteration mid-edit; paste Latin/Cyrillic/emoji, cut a selection and verify content and selection.
- Undo and redo typing, replacement, deletion, paste, cut and clear using keyboard shortcuts and native menu/gestures. Check for lost or duplicated text and restored selection.
- Reload, go offline and reopen, and check that documents and storage-failure warnings behave as documented.
- On iPhone, use the real software keyboard with predictive text and autocorrect on and off; try selection handles and undo gesture. Test an IME composition commit and cancellation if available.
- On desktop, try native context menus and real IME composition; record any failures or event sequences.

Playwright mobile viewport/touch emulation, Linux WebKit and synthetic IME/input events are not real mobile keyboard or IME tests. No real-device verification is claimed.

## UI screenshot evidence

Visual PRs can include `<!-- visual-evidence -->` in the PR description. A separate `visual-evidence` job (outside the container, Chromium only) then builds the exact base revision and captures before/after PNGs at 390 and 1400 px in light and dark appearance, using a synthetic document with Documents, Find, Settings and confirmation dialogs in separate screenshots. The `ui-before-after-<PR>` Actions artifact includes the screenshots and commit provenance and is retained for seven days. This is review evidence, not a hosted PR preview or physical-device verification. PRs that promise no visual change can also include `<!-- visual-identical -->`; Playwright then compares decoded pixels against the captured base, allowing zero changed pixels with its normal anti-aliasing treatment. Encoded PNG differences alone do not fail the gate. Other browser jobs still gate merging.
