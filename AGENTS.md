# Working on TypeBridge

Read the PRD, architecture and UI specification before changes. Treat them as design intent, not proof that a feature exists. Keep the app client-side and avoid introducing network calls, telemetry, third-party scripts or text transmission without an explicit product decision. Never log entered text.

Use TypeScript, Vite and vanilla HTML/CSS; avoid frameworks unless a maintainer decides otherwise. Separate pure transliteration rules from DOM, persistence and presentation. Prioritize IME, selection, caret, undo, accessibility and privacy. Add meaningful Vitest and Playwright coverage for behavior changed. Run type checking, tests and build when the scaffold exists. Keep documentation and backlog current; use small, reviewable changes. Do not claim deployment or test coverage before it exists.
