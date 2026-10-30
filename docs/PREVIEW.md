# Preview builds and production deployment

Pull requests run quality checks and Playwright in Chromium, Firefox and WebKit. They do not publish a preview or change production. To preview a branch locally, run `npm ci`, `npm run build`, and `npm run preview`, then open `/typebridge/`.

The historical PR #16 artifact-only workflow has been retired. A general hosted PR preview remains future work; do not use the production Pages environment for a PR-only artifact that could replace the live site. Any separate preview host needs a concrete design, permissions and cleanup policy first.

## Pages release gate

Pushes to main and manual dispatch on main run the reusable CI workflow for the same event revision before building the Pages artifact. That workflow must pass lint, typecheck, unit tests, production build and all three Playwright browser jobs. Pages build depends on the complete checks job; deploy depends on build. A failed, cancelled or skipped check prevents deployment. Manual dispatch from another branch is skipped.

The ordinary CI workflow still runs independently on main pushes and pull requests, preserving existing checks. Main pushes therefore run checks twice initially: ordinary CI plus the Pages gate. The duplicate work is deliberate to keep an explicit dependency on the exact revision without trusting another workflow's status or adding privileged workflow_run handling. It can be consolidated in a separately reviewed change.

Permissions remain read-only except for the deploy job's Pages write and OIDC token. Existing Pages concurrency and environment protections are retained. A workflow PR cannot prove the production gate by publishing: review the job graph, validate with actionlint, and observe the first authorized main deployment after merge.

## Manual browser checks

Review production-build input, selection, Undo/Redo, clipboard, reload, offline use and local-storage failures. Real Safari/iOS, Android keyboards and real IMEs need device testing; Linux WebKit and synthetic events do not establish that coverage.
