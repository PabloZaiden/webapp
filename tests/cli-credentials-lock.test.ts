import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, statSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname } from "node:path";
import {
  createDeviceCredentialsStore,
  refreshDeviceCredentials,
  type StoredDeviceCredentials,
} from "@pablozaiden/webapp/cli";
import type { JsonFileStore } from "../src/cli/credentials";

const temporaryHomes: string[] = [];
const now = () => new Date("2026-01-01T00:00:00.000Z");

function credentials(overrides: Partial<StoredDeviceCredentials> = {}): StoredDeviceCredentials {
  return {
    baseUrl: "http://example.test",
    clientId: "cli",
    accessToken: "old-access",
    refreshToken: "old-refresh",
    tokenType: "Bearer",
    scope: "*",
    accessTokenExpiresAt: "2025-12-31T23:59:00.000Z",
    createdAt: "2025-12-31T00:00:00.000Z",
    updatedAt: "2025-12-31T00:00:00.000Z",
    ...overrides,
  };
}

function tokenResponse(): Response {
  return Response.json({
    access_token: "new-access",
    refresh_token: "new-refresh",
    token_type: "Bearer",
    expires_in: 600,
    scope: "*",
  });
}

function subprocessText(stream: ReadableStream<Uint8Array> | number | undefined): Promise<string> {
  if (!stream || typeof stream === "number") {
    throw new Error("Expected a piped subprocess stream");
  }
  return new Response(stream).text();
}

async function testHome(): Promise<string> {
  const home = await mkdtemp(`${tmpdir()}/webapp-cli-lock-`);
  temporaryHomes.push(home);
  return home;
}

function storeFor(home: string, fileName = "device-auth.json"): JsonFileStore<StoredDeviceCredentials> {
  return createDeviceCredentialsStore({
    appDirectoryName: "credentials",
    fileName,
    home,
  });
}

afterEach(async () => {
  await Promise.all(temporaryHomes.splice(0).map((home) => rm(home, { recursive: true, force: true })));
});

describe("CLI credential file locks", () => {
  test("serializes concurrent refreshes and rereads credentials after waiting", async () => {
    const store = storeFor(await testHome());
    const initial = credentials();
    await store.write(initial);

    let refreshCalls = 0;
    let firstRequestStarted!: () => void;
    const firstRequest = new Promise<void>((resolve) => {
      firstRequestStarted = resolve;
    });
    let releaseFirstRequest!: () => void;
    const firstRequestRelease = new Promise<void>((resolve) => {
      releaseFirstRequest = resolve;
    });
    const fetchFn = async (input: string | URL | Request) => {
      if (!String(input).endsWith("/api/auth/token")) {
        throw new Error("Unexpected request");
      }
      refreshCalls++;
      if (refreshCalls === 1) {
        firstRequestStarted();
        await firstRequestRelease;
      }
      return tokenResponse();
    };

    const rereadRefreshTokens: string[] = [];
    const originalRead = store.read.bind(store);
    store.read = async () => {
      const value = await originalRead();
      rereadRefreshTokens.push(value?.refreshToken ?? "missing");
      return value;
    };

    const first = refreshDeviceCredentials({
      credentials: initial,
      store,
      fetchFn: fetchFn as typeof fetch,
      now,
    });
    await firstRequest;
    const second = refreshDeviceCredentials({
      credentials: initial,
      store,
      fetchFn: fetchFn as typeof fetch,
      now,
    });
    releaseFirstRequest();

    const [firstResult, secondResult] = await Promise.all([first, second]);
    expect(refreshCalls).toBe(1);
    expect(rereadRefreshTokens).toEqual(["old-refresh", "new-refresh"]);
    expect(firstResult?.refreshToken).toBe("new-refresh");
    expect(secondResult?.refreshToken).toBe("new-refresh");
    expect((await store.read())?.accessToken).toBe("new-access");
    expect(statSync(dirname(store.path())).mode & 0o777).toBe(0o700);
    expect(statSync(store.path()).mode & 0o777).toBe(0o600);
  });

  test("serializes refreshes across separate Bun processes", async () => {
    const home = await testHome();
    let workerStarts = 0;
    let tokenRequests = 0;
    let firstTokenStarted!: () => void;
    const firstTokenRequest = new Promise<void>((resolve) => {
      firstTokenStarted = resolve;
    });
    let secondWorkerStarted!: () => void;
    const secondWorkerRequest = new Promise<void>((resolve) => {
      secondWorkerStarted = resolve;
    });
    let releaseFirstToken!: () => void;
    const firstTokenRelease = new Promise<void>((resolve) => {
      releaseFirstToken = resolve;
    });
    const server = Bun.serve({
      port: 0,
      fetch: async (request) => {
        const path = new URL(request.url).pathname;
        if (path === "/worker-started") {
          workerStarts++;
          if (workerStarts === 2) secondWorkerStarted();
          return new Response("ok");
        }
        if (path === "/api/auth/token") {
          tokenRequests++;
          if (tokenRequests === 1) {
            firstTokenStarted();
            await firstTokenRelease;
          }
          return tokenResponse();
        }
        return new Response("not found", { status: 404 });
      },
    });
    let first: ReturnType<typeof Bun.spawn> | undefined;
    let second: ReturnType<typeof Bun.spawn> | undefined;
    try {
      const store = storeFor(home);
      const initial = credentials({ baseUrl: `http://127.0.0.1:${server.port}` });
      await store.write(initial);
      const env = {
        ...process.env,
        CLI_LOCK_TEST_HOME: home,
        CLI_LOCK_TEST_BASE_URL: `http://127.0.0.1:${server.port}`,
      };
      first = Bun.spawn(["bun", "tests/fixtures/cli-refresh-worker.ts"], {
        cwd: process.cwd(),
        env,
        stdout: "pipe",
        stderr: "pipe",
      });
      await firstTokenRequest;
      second = Bun.spawn(["bun", "tests/fixtures/cli-refresh-worker.ts"], {
        cwd: process.cwd(),
        env,
        stdout: "pipe",
        stderr: "pipe",
      });
      await secondWorkerRequest;
      releaseFirstToken();

      const [firstExit, secondExit, firstOutput, secondOutput, firstError, secondError] = await Promise.all([
        first.exited,
        second.exited,
        subprocessText(first.stdout),
        subprocessText(second.stdout),
        subprocessText(first.stderr),
        subprocessText(second.stderr),
      ]);
      expect(firstExit).toBe(0);
      expect(secondExit).toBe(0);
      expect(firstOutput.trim()).toBe("ok");
      expect(secondOutput.trim()).toBe("ok");
      expect(firstError).toBe("");
      expect(secondError).toBe("");
      expect(tokenRequests).toBe(1);
      expect((await store.read())?.refreshToken).toBe("new-refresh");
    } finally {
      releaseFirstToken();
      if (first && first.exitCode === null) first.kill();
      if (second && second.exitCode === null) second.kill();
      server.stop(true);
    }
  });

  test("releases the lock when the refresh request fails", async () => {
    const store = storeFor(await testHome());
    const initial = credentials();
    await store.write(initial);
    let refreshCalls = 0;
    const fetchFn = async (_input: string | URL | Request, _init?: RequestInit) => {
      refreshCalls++;
      if (refreshCalls === 1) throw new Error("network failure");
      return tokenResponse();
    };

    await expect(refreshDeviceCredentials({ credentials: initial, store, fetchFn: fetchFn as typeof fetch, now })).rejects.toThrow("network failure");
    const result = await refreshDeviceCredentials({ credentials: initial, store, fetchFn: fetchFn as typeof fetch, now });

    expect(result?.refreshToken).toBe("new-refresh");
    expect(refreshCalls).toBe(2);
  });

  test("releases the lock when the token response cannot be parsed", async () => {
    const store = storeFor(await testHome());
    const initial = credentials();
    await store.write(initial);
    let refreshCalls = 0;
    const fetchFn = async (_input: string | URL | Request, _init?: RequestInit) => {
      refreshCalls++;
      if (refreshCalls === 1) return new Response("not-json", { status: 200 });
      return tokenResponse();
    };

    await expect(refreshDeviceCredentials({ credentials: initial, store, fetchFn: fetchFn as typeof fetch, now })).rejects.toThrow("Token response is invalid");
    const result = await refreshDeviceCredentials({ credentials: initial, store, fetchFn: fetchFn as typeof fetch, now });

    expect(result?.refreshToken).toBe("new-refresh");
    expect(refreshCalls).toBe(2);
  });

  test("releases the lock when writing refreshed credentials fails", async () => {
    const store = storeFor(await testHome());
    const initial = credentials();
    await store.write(initial);
    const originalWrite = store.write.bind(store);
    let failWrite = true;
    store.write = async (value) => {
      if (failWrite) {
        failWrite = false;
        throw new Error("write failure");
      }
      await originalWrite(value);
    };
    let refreshCalls = 0;
    const fetchFn = async (_input: string | URL | Request, _init?: RequestInit) => {
      refreshCalls++;
      return tokenResponse();
    };

    await expect(refreshDeviceCredentials({ credentials: initial, store, fetchFn: fetchFn as typeof fetch, now })).rejects.toThrow("write failure");
    const result = await refreshDeviceCredentials({ credentials: initial, store, fetchFn: fetchFn as typeof fetch, now });

    expect(result?.refreshToken).toBe("new-refresh");
    expect(refreshCalls).toBe(2);
  });

  test("propagates reread failures after acquiring the lock", async () => {
    const store = storeFor(await testHome());
    const initial = credentials();
    await store.write(initial);
    const originalRead = store.read.bind(store);
    let failRead = true;
    store.read = async () => {
      if (failRead) {
        failRead = false;
        throw new Error("read failure");
      }
      return originalRead();
    };
    let refreshCalls = 0;
    const fetchFn = async (_input: string | URL | Request, _init?: RequestInit) => {
      refreshCalls++;
      return tokenResponse();
    };

    await expect(refreshDeviceCredentials({ credentials: initial, store, fetchFn: fetchFn as typeof fetch, now })).rejects.toThrow("read failure");
    const result = await refreshDeviceCredentials({ credentials: initial, store, fetchFn: fetchFn as typeof fetch, now });

    expect(result?.refreshToken).toBe("new-refresh");
    expect(refreshCalls).toBe(1);
  });

  test("times out on a lock held by an active process without deleting it", async () => {
    const store = storeFor(await testHome());
    let entered!: () => void;
    const lockEntered = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let release!: () => void;
    const releaseLock = new Promise<void>((resolve) => {
      release = resolve;
    });
    const holder = store.withLock!(async () => {
      entered();
      await releaseLock;
    });
    await lockEntered;

    await expect(store.withLock!(async () => undefined, { timeoutMs: 0 })).rejects.toMatchObject({ code: "timeout" });

    release();
    await holder;
  });

  test("recovers a stale lock owned by a terminated process", async () => {
    const store = storeFor(await testHome());
    const initial = credentials();
    await store.write(initial);
    const child = Bun.spawn(["bun", "-e", ""]);
    const stalePid = child.pid;
    await child.exited;
    const lockPath = `${store.path()}.lock`;
    await Bun.write(lockPath, `${JSON.stringify({
      version: 1,
      pid: stalePid,
      createdAt: Date.now() - 10 * 60_000,
      owner: "stale-owner",
    })}\n`);
    chmodSync(lockPath, 0o600);

    let refreshCalls = 0;
    const result = await refreshDeviceCredentials({
      credentials: initial,
      store,
      fetchFn: (async (_input: string | URL | Request, _init?: RequestInit) => {
        refreshCalls++;
        return tokenResponse();
      }) as typeof fetch,
      now,
    });

    expect(result?.refreshToken).toBe("new-refresh");
    expect(refreshCalls).toBe(1);
    expect(await Bun.file(lockPath).exists()).toBe(false);
  });

  test("does not share a lock between different credential paths", async () => {
    const home = await testHome();
    const firstStore = storeFor(home, "first.json");
    const secondStore = storeFor(home, "second.json");
    await firstStore.write(credentials());
    await secondStore.write(credentials());

    let entered!: () => void;
    const firstEntered = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let release!: () => void;
    const releaseFirst = new Promise<void>((resolve) => {
      release = resolve;
    });
    const holder = firstStore.withLock!(async () => {
      entered();
      await releaseFirst;
    });
    await firstEntered;

    const result = await refreshDeviceCredentials({
      credentials: credentials(),
      store: secondStore,
      fetchFn: (async (_input: string | URL | Request, _init?: RequestInit) => tokenResponse()) as typeof fetch,
      now,
    });

    expect(result?.refreshToken).toBe("new-refresh");
    release();
    await holder;
  });
});
