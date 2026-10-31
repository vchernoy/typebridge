# Contributing to TypeBridge

These rules apply to every contributor: people, AI coding agents and review bots. Read [AGENTS.md](AGENTS.md) for coding and product constraints, and the [README](README.md) for local setup.

## Issues first

- Every pull request links at least one issue, using `Closes #N` for an issue it completes or `Refs #N` for one it only advances.
- If no issue exists for the work, open one first that describes the problem and acceptance criteria.

## Before opening a pull request

Run `npm run lint`, `npm run format:check`, `npm run typecheck`, `npm run test:unit` and `npm run build`, and run the Playwright tests that cover what you changed (`npm run test:e2e`). Add or update tests for behavior you change. In the PR description, say what changed, how you validated it, and what you could not check (for example real devices or other browsers).

## Review

A pull request needs an **independent review** before it can be merged. Independent means the reviewer is not the person or agent session that wrote the change: the maintainer, another contributor, another agent session, or a review bot. The reviewer posts the review on the PR with a verdict and each finding labeled with a severity:

| Severity | Meaning | Effect on merging |
| --- | --- | --- |
| **P0** | Data loss or corruption, a security or privacy problem, or a broken build or deployment. | Blocks merge. |
| **P1** | Wrong behavior or a regression, an accessibility barrier such as a keyboard trap, or failing CI. | Blocks merge. |
| **P2** | A real but limited defect, a missing test for changed behavior, or misleading documentation. | Does not block. Track it (see below). |
| **P3** | Polish, style, cleanup or optional hardening. | Does not block. Track it if worth doing. |

The author answers every finding on the PR: fixed (with the commit), or not fixed and why. If code changes after a review in a way that affects behavior, the reviewer looks at the new changes again. A clean merge of `main` into the branch does not need a new review.

## Ready to merge

A pull request is ready when all of these hold:

1. It links an issue.
2. CI is green on the final head commit (quality and Chromium, Firefox and WebKit).
3. An independent review on the current changes reports no open P0 or P1 findings.
4. It has no merge conflict.

**Only the maintainer merges**, or an agent the maintainer has explicitly asked to merge that specific PR. Reviews and bots never merge on their own. Merge with **squash**, keeping the PR number in the commit title.

## Findings that remain after merging

If a merged PR leaves P2 or P3 findings open, record them before or right after merging, either in the linked issue (if it stays open) or in a new issue that links the PR. Close an issue once every finding recorded in it has been fixed by merged PRs.

## Merge conflicts

Resolve a conflict in one of two ways:

- **Merge `main` into the PR branch.** Anyone working on the PR may do this.
- **Rebase onto `main`.** Only the PR's author does this, and pushes with `git push --force-with-lease`, so another contributor's push to the branch is never overwritten.

Before resolving, fetch the branch: if someone else has already pushed a resolution, use theirs instead of racing it. After resolving, rerun the checks; CI must be green on the new head.
