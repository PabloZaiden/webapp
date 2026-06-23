import { chmodSync } from "node:fs";
import { mkdir, readFile, rename, rm } from "node:fs/promises";
import { dirname, join } from "node:path";

export interface JsonFileStore<T> {
  path(): string;
  read(): Promise<T | undefined>;
  write(value: T): Promise<void>;
  clear(): Promise<void>;
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
      await mkdir(dir, { recursive: true, mode: 0o700 });
      chmodIfPossible(dir, 0o700);
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
  };
}
