# Agent instructions

- Keep development cross-platform across macOS and Linux on both arm64 and x86-64.
- Do not hard-code OS-specific executable paths, browser paths, GNU-only flags, or architecture-specific binaries.
- Use Playwright for all browser automation and screenshot capture. Do not automate screenshots by launching Chrome directly from platform-specific paths.
- Keep Bun native hot reload as the development path: one Bun server serves the React UI, API routes and websockets.
- When adding CI, Docker or release automation for framework apps, follow `docs/github-actions.md`.
