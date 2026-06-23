# Agent instructions

- Keep development cross-platform across macOS and Linux on both arm64 and x86-64.
- Do not hard-code OS-specific executable paths, browser paths, GNU-only flags, or architecture-specific binaries.
- Use Playwright for all browser automation and screenshot capture. Do not automate screenshots by launching Chrome directly from platform-specific paths.
- When taking screenshots to validate a visual change, review the screenshots against the specific goal; capturing them is not enough.
- Validate that functional changes actually work with Playwright, exercising the affected UI flow end-to-end, unless the change is very simple and has no meaningful browser-facing behavior.
- Test user-visible functionality and behavior, not implementation details. Do not add brittle UI tests that assert internal class names, DOM structure or component implementation details.
- Keep Bun native hot reload as the development path: one Bun server serves the React UI, API routes and websockets.
- When adding CI, Docker or release automation for framework apps, follow `docs/github-actions.md`.
- All destructive delete actions must use the framework `ConfirmDialog` before calling the delete endpoint. Do not wire delete buttons directly to mutations.
