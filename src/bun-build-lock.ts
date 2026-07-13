import { createHash } from "node:crypto";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

let previousBuild: Promise<void> = Promise.resolve();

const LOCK_METADATA_VERSION = 1;
const LOCK_TIMEOUT_MS = 5 * 60_000;
const LOCK_STALE_AFTER_MS = 5 * 60_000;
const LOCK_POLL_INTERVAL_MS = 25;

interface LockMetadata {
  version: typeof LOCK_METADATA_VERSION;
  pid: number;
  createdAt: number;
  owner: string;
}

interface OwnedLock {
  path: string;
  metadata: LockMetadata;
}

type LockState = LockMetadata | "invalid" | undefined;

function errorCode(error: unknown): string | undefined {
  if (!error || typeof error !== "object" || !("code" in error)) return undefined;
  return typeof error.code === "string" ? error.code : undefined;
}

function lockPathFor(): string {
  const scope = process.env["HOME"] ?? process.env["USERPROFILE"] ?? process.env["USER"] ?? "default";
  const key = createHash("sha256").update(scope).digest("hex");
  return join(tmpdir(), `webapp-bun-build-${key}`);
}

function metadataPath(lockPath: string): string {
  return join(lockPath, "owner.json");
}

function parseLockMetadata(value: string): LockMetadata | "invalid" {
  if (value.length > 4096) return "invalid";
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!parsed || typeof parsed !== "object") return "invalid";
    const record = parsed as Record<string, unknown>;
    if (
      record["version"] !== LOCK_METADATA_VERSION
      || !Number.isSafeInteger(record["pid"])
      || Number(record["pid"]) <= 0
      || typeof record["createdAt"] !== "number"
      || !Number.isFinite(record["createdAt"])
      || typeof record["owner"] !== "string"
      || record["owner"].length === 0
    ) {
      return "invalid";
    }
    return {
      version: LOCK_METADATA_VERSION,
      pid: record["pid"] as number,
      createdAt: record["createdAt"],
      owner: record["owner"],
    };
  } catch {
    return "invalid";
  }
}

async function readLockMetadata(path: string): Promise<LockState> {
  try {
    return parseLockMetadata(await readFile(metadataPath(path), "utf8"));
  } catch (error) {
    if (errorCode(error) === "ENOENT") return undefined;
    throw error;
  }
}

async function lockAge(path: string): Promise<number | undefined> {
  try {
    return Date.now() - (await stat(path)).mtimeMs;
  } catch (error) {
    if (errorCode(error) === "ENOENT") return undefined;
    throw error;
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return errorCode(error) !== "ESRCH";
  }
}

function sameOwner(left: LockMetadata, right: LockMetadata): boolean {
  return left.version === right.version
    && left.pid === right.pid
    && left.createdAt === right.createdAt
    && left.owner === right.owner;
}

function sameLockState(left: LockState, right: LockState): boolean {
  if (left === undefined || right === undefined || left === "invalid" || right === "invalid") {
    return left === right;
  }
  return sameOwner(left, right);
}

function waitForLock(ms: number): Promise<void> {
  // Filesystems do not provide a portable event for an advisory lock release.
  return new Promise((resolveWait) => setTimeout(resolveWait, ms));
}

async function reclaimStaleLock(path: string, observed: LockState): Promise<boolean> {
  const age = await lockAge(path);
  if (age === undefined || age < LOCK_STALE_AFTER_MS) return false;

  const current = await readLockMetadata(path);
  if (!sameLockState(observed, current)) return false;
  if (current && current !== "invalid" && isProcessAlive(current.pid)) return false;

  try {
    await rm(path, { recursive: true, force: true });
  } catch (error) {
    if (errorCode(error) !== "ENOENT") throw error;
  }
  return true;
}

async function acquireFileLock(): Promise<OwnedLock> {
  const path = lockPathFor();
  const metadata: LockMetadata = {
    version: LOCK_METADATA_VERSION,
    pid: process.pid,
    createdAt: Date.now(),
    owner: crypto.randomUUID(),
  };
  const deadline = Date.now() + LOCK_TIMEOUT_MS;

  while (true) {
    try {
      await mkdir(path, { mode: 0o700 });
      try {
        await writeFile(metadataPath(path), `${JSON.stringify(metadata)}\n`, { mode: 0o600 });
      } catch (error) {
        await rm(path, { recursive: true, force: true });
        throw error;
      }
      return { path, metadata };
    } catch (error) {
      if (errorCode(error) !== "EEXIST") throw error;
    }

    const observed = await readLockMetadata(path);
    if (await reclaimStaleLock(path, observed)) continue;

    const now = Date.now();
    if (now >= deadline) {
      throw new Error("Timed out acquiring the Bun build lock.");
    }
    await waitForLock(Math.min(LOCK_POLL_INTERVAL_MS, Math.max(1, deadline - now)));
  }
}

async function releaseFileLock(lock: OwnedLock): Promise<void> {
  const current = await readLockMetadata(lock.path);
  if (current === undefined) return;
  if (current === "invalid" || !sameOwner(current, lock.metadata)) {
    throw new Error("Unable to verify ownership of the Bun build lock.");
  }
  try {
    await rm(lock.path, { recursive: true });
  } catch (error) {
    if (errorCode(error) === "ENOENT") return;
    throw new Error("Unable to release the Bun build lock.", { cause: error });
  }
}

async function withFileLock<T>(operation: () => Promise<T>): Promise<T> {
  const lock = await acquireFileLock();
  let result!: T;
  let operationFailed = false;
  let operationError: unknown;
  try {
    result = await operation();
  } catch (error) {
    operationFailed = true;
    operationError = error;
  }

  let releaseFailed = false;
  let releaseError: unknown;
  try {
    await releaseFileLock(lock);
  } catch (error) {
    releaseFailed = true;
    releaseError = error;
  }

  if (operationFailed && releaseFailed) {
    throw new AggregateError([operationError, releaseError], "Bun build and lock release failed");
  }
  if (operationFailed) throw operationError;
  if (releaseFailed) throw releaseError;
  return result;
}

export async function withBunBuildLock<T>(
  operation: () => Promise<T>,
): Promise<T> {
  const waitForPreviousBuild = previousBuild;
  let releaseBuild: (() => void) | undefined;
  previousBuild = new Promise<void>((resolvePreviousBuild) => {
    releaseBuild = resolvePreviousBuild;
  });
  await waitForPreviousBuild;
  try {
    return await withFileLock(operation);
  } finally {
    releaseBuild?.();
  }
}
