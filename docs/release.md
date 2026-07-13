# Release and publishing

## Pull requests

`PR Checks` runs on every pull request:

1. Install dependencies with `bun install --frozen-lockfile`.
2. Run `bun run tsc`.
3. Run `bun run test`, which runs the build-binary integration tests in an isolated process before the remaining suites.
4. Build both example apps.
5. Start the compiled example binaries and smoke-test `/api/health` plus one app endpoint.

## Main branch

`Main Docker Smoke` runs after merges to `main`:

1. Build Linux x64 and Linux arm64 binaries for both examples.
2. Build each Docker image with an explicit `linux/amd64` or `linux/arm64` platform and matching `APP_BINARY` path.
3. Validate missing, unsupported, and mismatched Docker arguments fail during the image build.
4. Run both architecture variants of both containers.
5. Smoke-test `/api/health` plus one app endpoint through the published container ports.

## NPM releases

`Release NPM Package` publishes `@pablozaiden/webapp` when a GitHub release is published. It also supports manual dispatch with a tag input, publishing with npm tag `unstable`.

The workflow:

1. Reads the version from the release tag, e.g. `v0.1.0` -> `0.1.0`.
2. Checks out that tag.
3. Updates `package.json` version in the workflow workspace.
4. Runs install, tests and build.
5. Publishes with npm provenance and public access.

## First manual publish / trusted publishing setup

For the first publish, npm may require a local manual publish before trusted publishing can be authorized for this GitHub repository.

1. Log in locally:
   ```bash
   npm login
   npm whoami
   ```
2. From a clean checkout, set the first version only in the local working tree:
   ```bash
   npm version 0.1.0 --no-git-tag-version
   ```
3. Inspect the package contents:
   ```bash
   npm pack --dry-run
   ```
4. Publish the scoped package publicly:
   ```bash
   npm publish --access public
   ```
5. Revert the local version edit if it should not be committed:
   ```bash
   git checkout -- package.json
   ```
6. In npm package settings for `@pablozaiden/webapp`, configure trusted publishing for GitHub Actions:
   - Owner/repository: `PabloZaiden/webapp`
   - Workflow: `release-npm-package.yml`
   - Environment: leave empty unless an environment is added later
7. After that, publish future versions by creating and publishing GitHub releases with tags like `v0.1.1`.
