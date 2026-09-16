import { chmodSync, mkdirSync, statSync } from "node:fs";

export type PrivatePathKind = "directory" | "file";

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
Set-Acl -LiteralPath $path -AclObject $security

$verified = Get-Acl -LiteralPath $path
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

function secureWindowsPrivatePath(path: string, kind: PrivatePathKind): void {
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
  if (process.platform === "win32") {
    secureWindowsPrivatePath(path, kind);
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
