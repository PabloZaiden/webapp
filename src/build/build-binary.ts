import { chmodSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

export type BunCompileTarget =
  | "bun-linux-x64"
  | "bun-linux-arm64"
  | "bun-darwin-x64"
  | "bun-darwin-arm64"
  | "bun-windows-x64";

export interface BuildWebAppBinaryOptions {
  entrypoint: string;
  outfile: string;
  target?: BunCompileTarget;
  define?: Record<string, string>;
}

export function getBunCompileTargetFromArgs(argv = Bun.argv): BunCompileTarget | undefined {
  const raw = argv.find((arg) => arg.startsWith("--target="))?.slice("--target=".length);
  return raw as BunCompileTarget | undefined;
}

export async function buildWebAppBinary(options: BuildWebAppBinaryOptions): Promise<void> {
  mkdirSync(dirname(options.outfile), { recursive: true });
  const result = await Bun.build({
    entrypoints: [options.entrypoint],
    target: "bun",
    minify: true,
    sourcemap: "external",
    define: options.define,
    compile: options.target ? { target: options.target, outfile: options.outfile } : { outfile: options.outfile },
  });
  if (!result.success) {
    for (const log of result.logs) {
      console.error(log);
    }
    throw new Error("Binary build failed");
  }
  if (process.platform !== "win32" && !options.target?.startsWith("bun-windows")) {
    chmodSync(options.outfile, 0o755);
  }
}
