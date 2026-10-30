import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { chmod, mkdir, mkdtemp, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  createJsonFileStore,
  JsonFileStoreLockError,
} from "@pablozaiden/webapp/cli";
import {
  ensurePrivateDirectory,
  securePrivateDirectory,
  securePrivateFile,
  securePrivatePath,
} from "@pablozaiden/webapp/server";

test("protects application-owned private directories and files", async () => {
  const root = await mkdtemp(join(tmpdir(), "webapp-private-state-"));
  const directory = join(root, "state");
  const file = join(directory, "credentials.json");
  try {
    ensurePrivateDirectory(directory);
    await Bun.write(file, "{}\n");
    securePrivateFile(file);

    expect(await Bun.file(file).text()).toBe("{}\n");
    expect((await stat(directory)).mode & 0o777).toBe(0o700);
    expect((await stat(file)).mode & 0o777).toBe(0o600);

    expect(() => securePrivateDirectory(file)).toThrow(
      "Private path kind does not match the filesystem entry",
    );
    expect(() => securePrivateFile(directory)).toThrow(
      "Private path kind does not match the filesystem entry",
    );
    // JavaScript callers still need the runtime validation provided by this public API.
    const secureWithRuntimeKind = securePrivatePath as (path: string, kind: string) => void;
    expect(() => secureWithRuntimeKind(file, "invalid")).toThrow(
      "Invalid private path kind",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("upgrades existing JSON store and lock files before reading them", async () => {
  const root = await mkdtemp(join(tmpdir(), "webapp-existing-private-state-"));
  const directory = join(root, "state");
  const file = join(directory, "credentials.json");
  const lock = `${file}.lock`;
  try {
    await mkdir(directory);
    await Bun.write(file, `${JSON.stringify({ token: "secret" })}\n`);
    await Bun.write(lock, `${JSON.stringify({
      version: 1,
      pid: process.pid,
      createdAt: Date.now(),
      owner: crypto.randomUUID(),
    })}\n`);
    await chmod(directory, 0o777);
    await chmod(file, 0o666);
    await chmod(lock, 0o666);

    const store = createJsonFileStore<{ token: string }>({
      stateDirectory: () => directory,
      fileName: "credentials.json",
      parse: value => value as { token: string },
    });
    expect(await store.read()).toEqual({ token: "secret" });
    await expect(store.withLock!(
      async () => undefined,
      { timeoutMs: 0, staleAfterMs: 60_000, pollIntervalMs: 1 },
    )).rejects.toBeInstanceOf(JsonFileStoreLockError);

    expect((await stat(directory)).mode & 0o777).toBe(0o700);
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    expect((await stat(lock)).mode & 0o777).toBe(0o600);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("upgrades an existing SQLite authentication database before opening it", async () => {
  const root = await mkdtemp(join(tmpdir(), "webapp-existing-sqlite-state-"));
  const directory = join(root, "state");
  const file = join(directory, "legacy.sqlite");
  try {
    await mkdir(directory);
    const legacy = new Database(file);
    legacy.close();
    await chmod(file, 0o666);

    const script = [
      'import { sqliteWebAppStore } from "@pablozaiden/webapp/server";',
      `const store = sqliteWebAppStore({ dataDir: ${JSON.stringify(directory)}, fileName: "legacy.sqlite" });`,
      "store.initialize();",
    ].join("\n");
    const child = Bun.spawn([process.execPath, "-e", script], {
      cwd: process.cwd(),
      stdout: "pipe",
      stderr: "pipe",
    });
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      child.stdout ? new Response(child.stdout).text() : "",
      child.stderr ? new Response(child.stderr).text() : "",
    ]);
    expect(stdout).toBe("");
    expect(stderr).toBe("");
    expect(exitCode).toBe(0);

    expect((await stat(file)).mode & 0o777).toBe(0o600);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
