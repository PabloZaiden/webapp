import { createDeviceCredentialsStore } from "../../src/cli/device-auth";

const home = process.env["CLI_STALE_LOCK_TEST_HOME"];
const baseUrl = process.env["CLI_STALE_LOCK_TEST_BASE_URL"];
const workerId = process.env["CLI_STALE_LOCK_TEST_WORKER"];
if (!home || !baseUrl || !workerId) {
  throw new Error("CLI stale lock worker configuration is missing");
}

const store = createDeviceCredentialsStore({
  appDirectoryName: "credentials",
  home,
});

const notify = async (path: string): Promise<void> => {
  const response = await fetch(`${baseUrl}${path}`);
  if (!response.ok) {
    throw new Error(`Coordination request failed with status ${response.status}`);
  }
};

const errorMessage = (error: unknown): string => error instanceof Error ? error.message : String(error);

try {
  await notify(`/started?worker=${encodeURIComponent(workerId)}`);
  await store.withLock!(async () => {
    await notify(`/entered?worker=${encodeURIComponent(workerId)}`);
    await notify(`/wait?worker=${encodeURIComponent(workerId)}`);
  }, {
    timeoutMs: 2_000,
    staleAfterMs: 0,
    pollIntervalMs: 1,
  });
  await notify(`/done?worker=${encodeURIComponent(workerId)}`);
  process.stdout.write("entered\n");
} catch (error) {
  if (
    error &&
    typeof error === "object" &&
    "code" in error &&
    error.code === "timeout"
  ) {
    await notify(`/timed-out?worker=${encodeURIComponent(workerId)}`);
    process.stdout.write("timed-out\n");
  } else {
    await fetch(`${baseUrl}/error?worker=${encodeURIComponent(workerId)}&message=${encodeURIComponent(errorMessage(error))}`);
    process.stderr.write(`${errorMessage(error)}\n`);
    process.exitCode = 1;
  }
}
