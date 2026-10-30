import { chmodSync, mkdirSync, statSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";

export type PrivatePathKind = "directory" | "file";

export function securePrivatePath(path: string, kind: PrivatePathKind): void {
  if (kind !== "directory" && kind !== "file") {
    throw new TypeError(`Invalid private path kind: ${String(kind)}`);
  }
  const stats = statSync(path);
  if (!(kind === "directory" ? stats.isDirectory() : stats.isFile())) {
    throw new Error(`Private path kind does not match the filesystem entry: ${path}`);
  }
  const expectedMode = kind === "directory" ? 0o700 : 0o600;
  chmodSync(path, expectedMode);
  const actualMode = statSync(path).mode & 0o777;
  if (actualMode !== expectedMode) {
    throw new Error(
      `Unable to verify private ${kind} permissions for ${path}: `
      + `expected ${expectedMode.toString(8)}, got ${actualMode.toString(8)}`,
    );
  }
}

export function securePrivateDirectory(path: string): void {
  securePrivatePath(path, "directory");
}

export function securePrivateFile(path: string): void {
  securePrivatePath(path, "file");
}

export function ensurePrivateDirectory(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  securePrivateDirectory(path);
}

function assertPrivateChild(path: string, privateDirectory: string): void {
  const childPath = relative(resolve(privateDirectory), resolve(path));
  if (!childPath || childPath.startsWith("..") || isAbsolute(childPath)) {
    throw new Error(`${path} must be a child of private directory ${privateDirectory}`);
  }
}

export function securePrivateChildDirectory(path: string, privateDirectory: string): void {
  assertPrivateChild(path, privateDirectory);
  securePrivateDirectory(path);
}

export function securePrivateChildFile(path: string, privateDirectory: string): void {
  assertPrivateChild(path, privateDirectory);
  securePrivateFile(path);
}
