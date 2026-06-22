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
  await Bun.$`mkdir -p ${options.outfile.split("/").slice(0, -1).join("/") || "."}`;
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
  if (!options.target?.startsWith("bun-windows")) {
    await Bun.$`chmod +x ${options.outfile}`;
  }
}
