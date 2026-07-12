import { chmodSync } from "node:fs";
import { link, mkdir, readFile, rename, rm } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

export interface JsonFileStoreLockOptions {
  timeoutMs?: number;
  staleAfterMs?: number;
  pollIntervalMs?: number;
}

export type JsonFileStoreLockErrorCode = "timeout" | "release";

export class JsonFileStoreLockError extends Error {
  constructor(
    public readonly code: JsonFileStoreLockErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "JsonFileStoreLockError";
  }
}

export interface JsonFileStore<T> {
  path(): string;
  read(): Promise<T | undefined>;
  write(value: T): Promise<void>;
  clear(): Promise<void>;
  withLock?<R>(callback: () => Promise<R>, options?: JsonFileStoreLockOptions): Promise<R>;
}

const LOCK_METADATA_VERSION = 1;
const DEFAULT_LOCK_TIMEOUT_MS = 30_000;
const DEFAULT_LOCK_STALE_AFTER_MS = 5 * 60_000;
const DEFAULT_LOCK_POLL_INTERVAL_MS = 25;

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

function ensureFiniteOption(name: string, value: number, minimum: number): number {
  if (!Number.isFinite(value) || value < minimum) {
    throw new RangeError(`${name} must be a finite number >= ${minimum}`);
  }
  return value;
}

function resolveLockOptions(options?: JsonFileStoreLockOptions): Required<JsonFileStoreLockOptions> {
  return {
    timeoutMs: ensureFiniteOption("timeoutMs", options?.timeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS, 0),
    staleAfterMs: ensureFiniteOption("staleAfterMs", options?.staleAfterMs ?? DEFAULT_LOCK_STALE_AFTER_MS, 0),
    pollIntervalMs: ensureFiniteOption("pollIntervalMs", options?.pollIntervalMs ?? DEFAULT_LOCK_POLL_INTERVAL_MS, 1),
  };
}

function secureDirectory(path: string): Promise<void> {
  return mkdir(path, { recursive: true, mode: 0o700 }).then(() => {
    chmodIfPossible(path, 0o700);
  });
}

function lockPathFor(target: string): string {
  return `${target}.lock`;
}

function lockCandidatePath(lockPath: string): string {
  const dir = dirname(lockPath);
  return join(dir, `.${basename(lockPath)}.${process.pid}.${crypto.randomUUID()}.tmp`);
}

function parseLockMetadata(value: string): LockMetadata | "invalid" {
  if (value.length > 4096) return "invalid";
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!parsed || typeof parsed !== "object") return "invalid";
    const record = parsed as Record<string, unknown>;
    if (
      record["version"] !== LOCK_METADATA_VERSION ||
      !Number.isSafeInteger(record["pid"]) ||
      Number(record["pid"]) <= 0 ||
      typeof record["createdAt"] !== "number" ||
      !Number.isFinite(record["createdAt"]) ||
      typeof record["owner"] !== "string" ||
      record["owner"].length === 0
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
    return parseLockMetadata(await readFile(path, "utf8"));
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
  return left.version === right.version && left.pid === right.pid && left.createdAt === right.createdAt && left.owner === right.owner;
}

async function removePublishedLock(path: string, metadata: LockMetadata): Promise<void> {
  const current = await readLockMetadata(path);
  if (!current || current === "invalid" || !sameOwner(current, metadata)) return;
  await rm(path, { force: true });
}

async function publishLock(path: string, metadata: LockMetadata): Promise<boolean> {
  const candidate = lockCandidatePath(path);
  let linked = false;
  let operationError: unknown;
  try {
    await Bun.write(candidate, `${JSON.stringify(metadata)}\n`);
    chmodIfPossible(candidate, 0o600);
    try {
      await link(candidate, path);
      linked = true;
    } catch (error) {
      if (errorCode(error) !== "EEXIST") operationError = error;
    }
  } catch (error) {
    operationError = error;
  }
  let cleanupError: unknown;
  try {
    await rm(candidate, { force: true });
  } catch (error) {
    cleanupError = error;
  }
  if (cleanupError !== undefined) {
    const errors: unknown[] = [cleanupError];
    if (operationError !== undefined) errors.unshift(operationError);
    if (linked) {
      try {
        await removePublishedLock(path, metadata);
      } catch (error) {
        errors.push(error);
      }
    }
    throw new AggregateError(errors, "Unable to create credentials lock");
  }
  if (operationError !== undefined) throw operationError;
  return linked;
}

async function reclaimStaleLock(path: string, expected: LockMetadata): Promise<void> {
  const current = await readLockMetadata(path);
  if (!current || current === "invalid" || !sameOwner(current, expected) || isProcessAlive(current.pid)) return;
  const confirmed = await readLockMetadata(path);
  if (!confirmed || confirmed === "invalid" || !sameOwner(confirmed, expected) || isProcessAlive(confirmed.pid)) return;
  try {
    await rm(path);
  } catch (error) {
    if (errorCode(error) !== "ENOENT") throw error;
  }
}

function waitForLock(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function acquireFileLock(target: string, options?: JsonFileStoreLockOptions): Promise<OwnedLock> {
  const resolved = resolveLockOptions(options);
  const path = lockPathFor(target);
  await secureDirectory(dirname(target));
  const metadata: LockMetadata = {
    version: LOCK_METADATA_VERSION,
    pid: process.pid,
    createdAt: Date.now(),
    owner: crypto.randomUUID(),
  };
  const deadline = Date.now() + resolved.timeoutMs;

  while (true) {
    if (await publishLock(path, metadata)) return { path, metadata };

    const current = await readLockMetadata(path);
    const now = Date.now();
    if (
      current &&
      current !== "invalid" &&
      current.createdAt <= now - resolved.staleAfterMs &&
      !isProcessAlive(current.pid)
    ) {
      await reclaimStaleLock(path, current);
      continue;
    }
    if (now >= deadline) {
      throw new JsonFileStoreLockError("timeout", "Timed out acquiring credentials lock");
    }
    await waitForLock(Math.min(resolved.pollIntervalMs, Math.max(1, deadline - now)));
  }
}

async function releaseFileLock(lock: OwnedLock): Promise<void> {
  let current: LockState;
  try {
    current = await readLockMetadata(lock.path);
  } catch (error) {
    throw new JsonFileStoreLockError("release", "Unable to verify credentials lock ownership", { cause: error });
  }
  if (current === undefined) return;
  if (current === "invalid" || !sameOwner(current, lock.metadata)) {
    throw new JsonFileStoreLockError("release", "Unable to verify credentials lock ownership");
  }
  try {
    await rm(lock.path);
  } catch (error) {
    if (errorCode(error) === "ENOENT") return;
    throw new JsonFileStoreLockError("release", "Unable to release credentials lock", { cause: error });
  }
}

async function withFileLock<T>(
  target: string,
  callback: () => Promise<T>,
  options?: JsonFileStoreLockOptions,
): Promise<T> {
  const lock = await acquireFileLock(target, options);
  let result!: T;
  let callbackFailed = false;
  let callbackError: unknown;
  try {
    result = await callback();
  } catch (error) {
    callbackFailed = true;
    callbackError = error;
  }

  let releaseFailed = false;
  let releaseError: unknown;
  try {
    await releaseFileLock(lock);
  } catch (error) {
    releaseFailed = true;
    releaseError = error;
  }

  if (callbackFailed && releaseFailed) {
    throw new AggregateError([callbackError, releaseError], "Credentials refresh and lock release failed");
  }
  if (callbackFailed) throw callbackError;
  if (releaseFailed) throw releaseError;
  return result;
}

function chmodIfPossible(path: string, mode: number): void {
  try {
    chmodSync(path, mode);
  } catch {
    // Not all platforms/filesystems support POSIX modes.
  }
}

export function createJsonFileStore<T>(input: {
  appDirectoryName: string;
  fileName: string;
  envHome?: string;
  parse(value: unknown): T;
  home?: string;
}): JsonFileStore<T> {
  const stateDir = () => {
    const explicit = input.envHome ? process.env[input.envHome]?.trim() : undefined;
    const home = input.home ?? process.env["HOME"]?.trim();
    if (explicit) return explicit;
    if (!home) throw new Error("HOME is not set");
    return join(home, input.appDirectoryName);
  };
  const filePath = () => join(stateDir(), input.fileName);
  return {
    path: filePath,
    async read() {
      try {
        return input.parse(JSON.parse(await readFile(filePath(), "utf8")) as unknown);
      } catch (error) {
        if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
          return undefined;
        }
        throw error;
      }
    },
    async write(value) {
      const target = filePath();
      const dir = dirname(target);
      await secureDirectory(dir);
      const temp = join(dir, `.${input.fileName}.${process.pid}.${crypto.randomUUID()}.tmp`);
      try {
        await Bun.write(temp, `${JSON.stringify(value, null, 2)}\n`);
        chmodIfPossible(temp, 0o600);
        await rename(temp, target);
        chmodIfPossible(target, 0o600);
      } catch (error) {
        await rm(temp, { force: true });
        throw error;
      }
    },
    async clear() {
      await rm(filePath(), { force: true });
    },
    async withLock<R>(callback: () => Promise<R>, options?: JsonFileStoreLockOptions) {
      return withFileLock(filePath(), callback, options);
    },
  };
}
