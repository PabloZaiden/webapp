import { expect, test } from "bun:test";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  ensurePrivateDirectory,
  securePrivateFile,
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
    if (process.platform !== "win32") {
      expect((await stat(directory)).mode & 0o777).toBe(0o700);
      expect((await stat(file)).mode & 0o777).toBe(0o600);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
