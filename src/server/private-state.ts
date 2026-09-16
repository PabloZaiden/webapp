import { chmodSync, mkdirSync, statSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";

export type PrivatePathKind = "directory" | "file";
const MAX_SECURED_WINDOWS_PATHS = 512;
const securedWindowsPaths = new Map<string, string>();

const WINDOWS_PRIVATE_PATH_SCRIPT = `
$ErrorActionPreference = "Stop"
$path = $env:WEBAPP_PRIVATE_PATH
$kind = $env:WEBAPP_PRIVATE_KIND
if ([string]::IsNullOrWhiteSpace($path)) {
  throw "WEBAPP_PRIVATE_PATH is required"
}

$item = Get-Item -LiteralPath $path -Force
$isDirectory = $item -is [System.IO.DirectoryInfo]
if (($kind -eq "directory") -ne $isDirectory) {
  throw "Private path kind does not match the filesystem entry"
}

$identity = [System.Security.Principal.WindowsIdentity]::GetCurrent()
$sid = $identity.User
if ($kind -eq "directory") {
  $security = [System.Security.AccessControl.DirectorySecurity]::new()
  $inheritance = [System.Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [System.Security.AccessControl.InheritanceFlags]::ObjectInherit
} else {
  $security = [System.Security.AccessControl.FileSecurity]::new()
  $inheritance = [System.Security.AccessControl.InheritanceFlags]::None
}
$security.SetOwner($sid)
$security.SetAccessRuleProtection($true, $false)
$rule = [System.Security.AccessControl.FileSystemAccessRule]::new(
  $sid,
  [System.Security.AccessControl.FileSystemRights]::FullControl,
  $inheritance,
  [System.Security.AccessControl.PropagationFlags]::None,
  [System.Security.AccessControl.AccessControlType]::Allow
)
[void]$security.AddAccessRule($rule)
$sections = [System.Security.AccessControl.AccessControlSections]::Owner -bor [System.Security.AccessControl.AccessControlSections]::Access
if ($kind -eq "directory") {
  [System.IO.Directory]::SetAccessControl($path, $security)
  $verified = [System.IO.Directory]::GetAccessControl($path, $sections)
} else {
  [System.IO.File]::SetAccessControl($path, $security)
  $verified = [System.IO.File]::GetAccessControl($path, $sections)
}
$owner = $verified.GetOwner([System.Security.Principal.SecurityIdentifier])
$rules = @($verified.GetAccessRules(
  $true,
  $true,
  [System.Security.Principal.SecurityIdentifier]
))
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
if (
  -not $verified.AreAccessRulesProtected -or
  $owner.Value -ne $sid.Value -or
  $matchingRules.Count -lt 1 -or
  $unexpectedRules.Count -ne 0
) {
  throw "Failed to verify the private Windows ACL"
}
`;

function assertPrivatePathKind(kind: unknown): asserts kind is PrivatePathKind {
  if (kind !== "directory" && kind !== "file") {
    throw new TypeError(`Invalid private path kind: ${String(kind)}`);
  }
}

function privatePathIdentity(path: string, kind: PrivatePathKind): string {
  const stats = statSync(path);
  const matchesKind = kind === "directory" ? stats.isDirectory() : stats.isFile();
  if (!matchesKind) {
    throw new Error(`Private path kind does not match the filesystem entry: ${path}`);
  }
  return `${String(stats.dev)}:${String(stats.ino)}:${String(stats.birthtimeMs)}`;
}

function windowsPathKey(path: string, kind: PrivatePathKind): string {
  return `${kind}:${resolve(path).toLowerCase()}`;
}

function rememberSecuredWindowsPath(path: string, kind: PrivatePathKind): void {
  const key = windowsPathKey(path, kind);
  securedWindowsPaths.delete(key);
  securedWindowsPaths.set(key, privatePathIdentity(path, kind));
  if (securedWindowsPaths.size > MAX_SECURED_WINDOWS_PATHS) {
    const oldest = securedWindowsPaths.keys().next().value;
    if (oldest !== undefined) {
      securedWindowsPaths.delete(oldest);
    }
  }
}

function isSecuredWindowsPath(path: string, kind: PrivatePathKind): boolean {
  return securedWindowsPaths.get(windowsPathKey(path, kind)) === privatePathIdentity(path, kind);
}

function secureWindowsPrivatePath(
  path: string,
  kind: PrivatePathKind,
  identity: string,
): void {
  const cacheKey = windowsPathKey(path, kind);
  if (securedWindowsPaths.get(cacheKey) === identity) {
    return;
  }
  const encodedScript = Buffer.from(WINDOWS_PRIVATE_PATH_SCRIPT, "utf16le").toString("base64");
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
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    windowsHide: true,
  });
  if (result.exitCode !== 0) {
    const stderr = new TextDecoder().decode(result.stderr).trim();
    throw new Error(
      `Unable to protect private ${kind} ${path} with a Windows ACL`
      + `${stderr ? `: ${stderr}` : ""}`,
    );
  }
  rememberSecuredWindowsPath(path, kind);
}

function securePosixPrivatePath(path: string, kind: PrivatePathKind): void {
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

export function securePrivatePath(path: string, kind: PrivatePathKind): void {
  assertPrivatePathKind(kind);
  const identity = privatePathIdentity(path, kind);
  if (process.platform === "win32") {
    secureWindowsPrivatePath(path, kind, identity);
    return;
  }
  securePosixPrivatePath(path, kind);
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
  const resolvedDirectory = resolve(privateDirectory);
  const childPath = relative(resolvedDirectory, resolve(path));
  if (!childPath || childPath.startsWith("..") || isAbsolute(childPath)) {
    throw new Error(`${path} must be a child of private directory ${privateDirectory}`);
  }
  if (
    process.platform === "win32"
    && !isSecuredWindowsPath(resolvedDirectory, "directory")
  ) {
    throw new Error(`Private Windows ACL has not been verified for ${privateDirectory}`);
  }
}

export function securePrivateChildDirectory(path: string, privateDirectory: string): void {
  assertPrivateChild(path, privateDirectory);
  if (process.platform === "win32") {
    rememberSecuredWindowsPath(path, "directory");
    return;
  }
  securePrivateDirectory(path);
}

export function securePrivateChildFile(path: string, privateDirectory: string): void {
  assertPrivateChild(path, privateDirectory);
  if (process.platform === "win32") {
    rememberSecuredWindowsPath(path, "file");
    return;
  }
  securePrivateFile(path);
}
