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

const WINDOWS_ACL_INSPECTION_SCRIPT = `
$ErrorActionPreference = "Stop"
$path = $env:WEBAPP_PRIVATE_PATH
$kind = $env:WEBAPP_PRIVATE_KIND
$sections = [System.Security.AccessControl.AccessControlSections]::Owner -bor [System.Security.AccessControl.AccessControlSections]::Access
if ($kind -eq "directory") {
  $security = [System.IO.Directory]::GetAccessControl($path, $sections)
} else {
  $security = [System.IO.File]::GetAccessControl($path, $sections)
}
$sid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
$owner = $security.GetOwner([System.Security.Principal.SecurityIdentifier])
$rules = @($security.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier]))
$fullControl = [System.Security.AccessControl.FileSystemRights]::FullControl
$matchingRules = @($rules | Where-Object {
  $_.IdentityReference.Value -eq $sid.Value -and
  $_.AccessControlType -eq [System.Security.AccessControl.AccessControlType]::Allow -and
  ($_.FileSystemRights -band $fullControl) -eq $fullControl
})
$unexpectedRules = @($rules | Where-Object {
  $_.IdentityReference.Value -ne $sid.Value -or
  $_.AccessControlType -ne [System.Security.AccessControl.AccessControlType]::Allow
})
[Console]::Out.WriteLine(($owner.Value -eq $sid.Value).ToString())
[Console]::Out.WriteLine($security.AreAccessRulesProtected.ToString())
[Console]::Out.WriteLine(($matchingRules.Count -ge 1).ToString())
[Console]::Out.WriteLine(($unexpectedRules.Count -eq 0).ToString())
`;

function expectWindowsPrivateAcl(path: string, kind: "directory" | "file"): void {
  const encodedScript = Buffer.from(WINDOWS_ACL_INSPECTION_SCRIPT, "utf16le").toString("base64");
  const result = Bun.spawnSync([
    "powershell.exe",
    "-NoLogo",
    "-NoProfile",
    "-NonInteractive",
    "-EncodedCommand",
    encodedScript,
  ], {
    env: {
      ...process.env,
      WEBAPP_PRIVATE_PATH: path,
      WEBAPP_PRIVATE_KIND: kind,
    },
    stdout: "pipe",
    stderr: "pipe",
    windowsHide: true,
  });
  expect(new TextDecoder().decode(result.stderr).trim()).toBe("");
  expect(result.exitCode).toBe(0);
  expect(new TextDecoder().decode(result.stdout).trim().split(/\r?\n/)).toEqual([
    "True",
    "True",
    "True",
    "True",
  ]);
}

test("protects application-owned private directories and files", async () => {
  const root = await mkdtemp(join(tmpdir(), "webapp-private-state-"));
  const directory = join(root, "state");
  const file = join(directory, "credentials.json");
  try {
    ensurePrivateDirectory(directory);
    await Bun.write(file, "{}\n");
    securePrivateFile(file);

    expect(await Bun.file(file).text()).toBe("{}\n");
    if (process.platform === "win32") {
      expectWindowsPrivateAcl(directory, "directory");
      expectWindowsPrivateAcl(file, "file");
    } else {
      expect((await stat(directory)).mode & 0o777).toBe(0o700);
      expect((await stat(file)).mode & 0o777).toBe(0o600);
    }

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
    if (process.platform !== "win32") {
      await chmod(directory, 0o777);
      await chmod(file, 0o666);
      await chmod(lock, 0o666);
    }

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

    if (process.platform === "win32") {
      expectWindowsPrivateAcl(directory, "directory");
      expectWindowsPrivateAcl(file, "file");
      expectWindowsPrivateAcl(lock, "file");
    } else {
      expect((await stat(directory)).mode & 0o777).toBe(0o700);
      expect((await stat(file)).mode & 0o777).toBe(0o600);
      expect((await stat(lock)).mode & 0o777).toBe(0o600);
    }
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
    if (process.platform !== "win32") {
      await chmod(file, 0o666);
    }

    const script = [
      'import { sqliteWebAppStore } from "@pablozaiden/webapp/server";',
      `const store = sqliteWebAppStore({ dataDir: ${JSON.stringify(directory)}, fileName: "legacy.sqlite" });`,
      "store.initialize();",
    ].join("\n");
    const child = Bun.spawn([process.execPath, "-e", script], {
      cwd: process.cwd(),
      stdout: "pipe",
      stderr: "pipe",
      windowsHide: true,
    });
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      child.stdout ? new Response(child.stdout).text() : "",
      child.stderr ? new Response(child.stderr).text() : "",
    ]);
    expect(stdout).toBe("");
    expect(stderr).toBe("");
    expect(exitCode).toBe(0);

    if (process.platform === "win32") {
      expectWindowsPrivateAcl(file, "file");
    } else {
      expect((await stat(file)).mode & 0o777).toBe(0o600);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
