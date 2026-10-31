# Preview builds and production deployment

Pull requests run quality checks and Playwright in Chromium, Firefox and WebKit. They do not publish a preview or change production. To preview a branch locally, run `npm ci`, `npm run build`, and `npm run preview`, then open the URL it prints.

The historical PR #16 artifact-only workflow has been retired. A general hosted PR preview remains future work; do not use the production Pages environment for a PR-only artifact that could replace the live site. Any separate preview host needs a concrete design, permissions and cleanup policy first.

## Pages release gate

Pushes to main and manual dispatch on main run the reusable CI workflow (`ci.yml`) for the same event revision. It must pass lint, typecheck, unit tests, the production build and all three Playwright browser jobs. Its quality job uploads that production build as the Pages artifact, and deploy depends on the whole checks job, so a failed, cancelled or skipped check prevents deployment and the deployed `dist` is the one the checks built. The Playwright jobs build the same commit from the same lockfile. Each job has a 15-minute timeout, so a hung check cannot hold the Pages concurrency lock for hours. Manual dispatch from another branch is skipped; deploy also checks the branch itself.

CI no longer has its own `push: main` trigger: on main the Pages gate is the single CI run for each revision. Pull requests and manual dispatch still run CI directly.

Permissions remain read-only except for the deploy job's Pages write and OIDC token. Existing Pages concurrency and environment protections are retained. A workflow PR cannot prove the production gate by publishing: review the job graph, validate with actionlint, and observe the first authorized main deployment after merge.

## Manual browser checks

Run on iPhone Safari and iPhone Chrome (both use WebKit on iOS), plus desktop Chrome, Firefox and Safari. Record browser/OS version, keyboard/language, steps and expected versus actual results in the pull request or issue being tested. Do not enter sensitive text in a public deployment.

- Type `privet`, `shchuka`, `yozh`; check the output and caret, then type in the middle of existing text.
- Select a range and replace it; use Backspace and Delete around Cyrillic, punctuation and emoji.
- Toggle transliteration mid-edit; paste Latin/Cyrillic/emoji, cut a selection and verify content and selection.
- Undo and redo typing, replacement, deletion, paste, cut and clear using keyboard shortcuts and native menu/gestures. Check for lost or duplicated text and restored selection.
- Reload, go offline and reopen, and check that drafts and storage-failure warnings behave as documented.
- On iPhone, use the real software keyboard with predictive text and autocorrect on and off; try selection handles and undo gesture. Test an IME composition commit and cancellation if available.
- On desktop, try native context menus and real IME composition; record any failures or event sequences.

Playwright mobile viewport/touch emulation, Linux WebKit and synthetic IME/input events are not real mobile keyboard or IME tests. No real-device verification is claimed.
