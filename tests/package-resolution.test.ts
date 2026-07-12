import { expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { findPackageRoot, resolveReactDomClient } from "../src/package-resolution";

function createTemporaryRoot(): string {
  return join(tmpdir(), `webapp-package-resolution-${crypto.randomUUID()}`);
}

function writeJson(path: string, value: unknown): void {
  writeFileSync(path, JSON.stringify(value, null, 2));
}

test("findPackageRoot selects the nearest application package in a workspace layout", () => {
  const fixtureRoot = createTemporaryRoot();
  const workspaceRoot = join(fixtureRoot, "workspace");
  const appRoot = join(workspaceRoot, "apps", "demo");
  const sourceDir = join(appRoot, "src");

  mkdirSync(sourceDir, { recursive: true });
  writeJson(join(workspaceRoot, "package.json"), { name: "fixture-workspace", private: true });
  writeJson(join(appRoot, "package.json"), { name: "fixture-demo", private: true });

  try {
    expect(findPackageRoot(sourceDir)).toBe(resolve(appRoot));
  } finally {
    rmSync(fixtureRoot, { recursive: true, force: true });
  }
});

test("resolveReactDomClient loads a non-hoisted package export from the application context", async () => {
  const fixtureRoot = createTemporaryRoot();
  const workspaceRoot = join(fixtureRoot, "workspace");
  const appRoot = join(workspaceRoot, "apps", "demo");
  const sourceDir = join(appRoot, "src");
  const entrypoint = join(sourceDir, "index.ts");
  const applicationReactDomRoot = join(appRoot, "node_modules", "react-dom");
  const workspaceReactDomRoot = join(workspaceRoot, "node_modules", "react-dom");

  mkdirSync(sourceDir, { recursive: true });
  mkdirSync(applicationReactDomRoot, { recursive: true });
  mkdirSync(workspaceReactDomRoot, { recursive: true });
  writeJson(join(workspaceRoot, "package.json"), { name: "fixture-workspace", private: true });
  writeJson(join(appRoot, "package.json"), {
    name: "fixture-demo",
    private: true,
    dependencies: { "react-dom": "fixture-nested" },
  });
  writeFileSync(entrypoint, "export {};\n");
  writeJson(join(workspaceReactDomRoot, "package.json"), {
    name: "react-dom",
    version: "fixture-parent",
    exports: { "./client": "./client.js" },
  });
  writeFileSync(join(workspaceReactDomRoot, "client.js"), 'export const fixtureResolution = "workspace";\n');
  writeJson(join(applicationReactDomRoot, "package.json"), {
    name: "react-dom",
    version: "fixture-nested",
    exports: { "./client": "./client.js" },
  });
  writeFileSync(join(applicationReactDomRoot, "client.js"), 'export const fixtureResolution = "application";\n');

  try {
    const applicationRoot = findPackageRoot(dirname(entrypoint));
    const resolvedPath = resolveReactDomClient(applicationRoot, entrypoint);
    const resolvedModule = await import(pathToFileURL(resolvedPath).href) as { fixtureResolution?: string };

    expect(resolvedModule.fixtureResolution).toBe("application");
  } finally {
    rmSync(fixtureRoot, { recursive: true, force: true });
  }
});

test("findPackageRoot reports when an application package is missing", () => {
  const fixtureRoot = createTemporaryRoot();
  const sourceDir = join(fixtureRoot, "src");
  mkdirSync(sourceDir, { recursive: true });

  try {
    expect(() => findPackageRoot(sourceDir)).toThrow(/Unable to find an application package root/);
  } finally {
    rmSync(fixtureRoot, { recursive: true, force: true });
  }
});

test("resolveReactDomClient reports the application context when react-dom is missing", () => {
  const fixtureRoot = createTemporaryRoot();
  const appRoot = join(fixtureRoot, "app");
  const sourceDir = join(appRoot, "src");
  const entrypoint = join(sourceDir, "index.ts");

  mkdirSync(sourceDir, { recursive: true });
  writeJson(join(appRoot, "package.json"), { name: "fixture-missing-react-dom", private: true });
  writeFileSync(entrypoint, "export {};\n");

  try {
    expect(() => resolveReactDomClient(findPackageRoot(sourceDir), entrypoint)).toThrow(
      new RegExp(`react-dom/client.*${appRoot.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`),
    );
  } finally {
    rmSync(fixtureRoot, { recursive: true, force: true });
  }
});
