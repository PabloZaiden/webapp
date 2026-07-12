# Agent instructions

## Cross-platform and framework conventions

- Keep development cross-platform across macOS and Linux on both arm64 and x86-64.
- Do not hard-code OS-specific executable paths, browser paths, GNU-only flags, or architecture-specific binaries.
- Keep Bun native hot reload as the development path: one Bun server serves the React UI, API routes and websockets.
- When adding CI, Docker or release automation for framework apps, follow `docs/github-actions.md`.

## Browser and UI validation

- Use Playwright for all browser automation and screenshot capture. Do not automate screenshots by launching Chrome directly from platform-specific paths.
- When taking screenshots to validate a visual change, review the screenshots against the specific goal; capturing them is not enough.
- Don't overwrite existing screenshots unless the user explicitly asks for it. When taking screenshots to validate a visual change, store them either in a temporary location or in a git-ignored folder.
- Validate that functional changes actually work with Playwright, exercising the affected UI flow end-to-end, unless the change is very simple and has no meaningful browser-facing behavior.

## Framework UI conventions

- All destructive delete actions must use the framework `ConfirmDialog` before calling the delete endpoint. Do not wire delete buttons directly to mutations.
- Route components rendered by `WebAppRoot.routes` must use `Page` as the top-level wrapper; do not render content directly into `.wapp-main-content` or duplicate the fixed framework title with an app-local heading.

## Runtime input and API boundaries

- Treat TypeScript types and casts as compile-time guidance only, never as runtime validation. Validate untrusted JSON, CLI values, headers, persisted JSON, and external responses before using them.
- Do not mass-assign request bodies into domain records. Define explicit create/update inputs and assign only allowlisted mutable fields.
- Return an intentional 4xx response for malformed or invalid client input; do not let generic exceptions turn it into a 500.
- Do not broadly catch parse or validation failures and replace them with success-shaped defaults. Surface the failure through the established error path.

## Reuse, consistency, errors, and lifecycle

- Search for and reuse existing clients, resolvers, helpers, and lifecycle abstractions before adding local alternatives.
- Make framework-owned UI use the same configured API client and error/authentication semantics exposed to applications.
- Keep path and package discovery in one shared implementation. Resolve dependencies through runtime or package-manager resolution rather than hardcoded `node_modules` layouts.
- Do not silently discard operational failures. Surface them through the repository's established UI, logging, or API patterns.
- Distinguish immediate termination from graceful shutdown. Graceful shutdown must provide explicit cleanup or drain hooks and observable completion.
- Do not use arbitrary sleeps or timeout values for synchronization unless a documented platform limitation leaves no event-driven alternative.

## Platform and deployment assumptions

- Preserve the project-wide macOS/Linux arm64/x86-64 support boundary. Do not make defaults silently select one CPU architecture when multiple architectures are supported.
- Validate enumerated build and CLI arguments before passing them to lower layers.
- If a component is intentionally Linux-only, document and enforce that support boundary instead of implying unsupported cross-platform behavior.
- Trust proxy-derived headers only through explicit configuration with a documented deployment trust model.
- State whether application data is persistent in examples. Do not pair durable-looking deployment configuration with silently ephemeral user data.

## Maintainable organization

- Keep modules focused. Split files that combine unrelated concerns such as document generation, authentication, route dispatch, WebSockets, process lifecycle, navigation, gestures, and administration.
- Centralize values shared by CSS and TypeScript.
- Name and document browser workarounds and timing heuristics.

## Test philosophy: behavior over implementation

- Prefer a smaller suite of high-value tests over broad regression accumulation.
- Test stable, externally observable behavior and contracts, not implementation details.
- Do not add automated tests for visual appearance or layout, including exact colors, spacing, blur, CSS variables, selectors, class names, DOM structure, or screenshot pixel baselines.
- Validate visual changes manually with temporary Playwright screenshots stored outside the repository or in a git-ignored location. Do not turn those checks into implementation-pinning regression tests unless an explicit product requirement calls for visual testing.
- Do not add tests whose purpose is only to prove the absence of an old implementation, filename, warning, bug symptom, or removed behavior when positive behavior covers the contract.
- Do not pin incidental copy, punctuation, generated markup, framework warning text, or internal object identity unless it is a documented public contract.
- Do not test test-only mocks or helpers independently when production tests already exercise them.
- Merge duplicate scenarios and parameterize equivalent platform or input variants.
- When reviewing existing tests, delete low-value visual/layout or historical-regression tests; rewrite them only when a stable core behavior is worth preserving.
