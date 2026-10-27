# PR 16 preview and manual testing

## Deployment status and isolation

The PR preview build workflow uploads a seven-day artifact; it does not deploy a site, and the artifact itself is not an iPhone-accessible preview URL. It uses read-only repository permission, no repository secrets, no privileged pull_request_target, and no stored checkout credentials. Its Vite base is `/typebridge/preview/pr-16/`; if an isolated host serves a different path, rebuild with that host's base.

GitHub Pages deploys the site's artifact as a whole. Publishing a PR-only artifact to the production Pages environment is not an isolated subdirectory deployment and could replace production. GitHub recommends deploying from the default branch and protecting the Pages environment: https://docs.github.com/en/pages/getting-started-with-github-pages/configuring-a-publishing-source-for-your-github-pages-site

A simple isolated option is a separate public preview repository and its own Pages site, with a trusted, manually triggered deployment of a reviewed commit and no production credentials exposed to PR code. This requires an independently configured Pages site and an authorized deployment mechanism; it is not configured here. Alternatively, a static preview hosting service can provide a separate URL with a scoped credential and trusted deployment. Neither option requires changing production. Artifacts expire after seven days; the eventual preview host should remove its PR deployment when testing ends, without deleting or modifying the production site.

## Manual checklist

Run on iPhone Safari and iPhone Chrome (both use WebKit on iOS), plus desktop Chrome, Firefox and Safari. Record browser/OS version, keyboard/language, steps and expected versus actual results in PR #16. Do not enter sensitive text in a public preview.

- Type `privet`, `shchuka`, `yozh`; check the output and caret, then type in the middle of existing text.
- Select a range and replace it; use Backspace and Delete around Cyrillic, punctuation and emoji.
- Toggle transliteration mid-edit; paste Latin/Cyrillic/emoji, cut a selection and verify content and selection.
- Undo and redo typing, replacement, deletion, paste, cut and clear using keyboard shortcuts and native menu/gestures. Check for lost or duplicated text and restored selection.
- On iPhone, use the real software keyboard with predictive text and autocorrect on and off; try selection handles and undo gesture. Test an IME composition commit and cancellation if available.
- On desktop, try native context menus and real IME composition; record any failures or event sequences.

Playwright mobile viewport/touch emulation and synthetic IME/input events are not real mobile keyboard or IME tests. No real-device verification is claimed.
