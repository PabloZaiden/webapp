import { expect, test } from "bun:test";
import { mkdir, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { authenticator } from "./support/authenticator";

test("optional app-owned passwords, passkeys and browser sessions survive process restart and enforce invalidation", async () => {
  const directory = resolve(".cache/tests", `auth-bonus-${crypto.randomUUID()}`);
  await mkdir(directory, { recursive: true });
  const reservation = Bun.serve({ hostname: "localhost", port: 0, fetch: () => new Response() });
  const port = reservation.port!;
  await reservation.stop(true);
  const origin = `http://localhost:${port}`;
  let child: ReturnType<typeof Bun.spawn> | undefined;
  let output: Promise<unknown> | undefined;
  async function start() {
    const next = Bun.spawn([process.execPath, "tests/fixtures/bonus-server.ts"], {
      env: { ...process.env, BONUS_HOST: "localhost", BONUS_PORT: String(port), BONUS_LOG_LEVEL: "error",
        BONUS_STATE: resolve(directory, "auth.json"), BONUS_ORIGIN: origin, NODE_ENV: "production" },
      stdout: "pipe", stderr: "pipe",
    });
    child = next;
    const stderr = new Response(next.stderr).text();
    const reader = next.stdout.getReader();
    const first = await reader.read();
    if (first.done || !new TextDecoder().decode(first.value).includes("BONUS_READY")) {
      throw new Error(`Bonus fixture did not start: ${await stderr}`);
    }
    output = Promise.all([(async () => {
      try { while (!(await reader.read()).done) { /* drain the child output */ } }
      finally { reader.releaseLock(); }
    })(), stderr]);
  }
  async function stop() {
    child?.kill("SIGTERM");
    if (child) expect(await child.exited).toBe(0);
    await output;
    child = undefined;
  }
  const post = (path: string, body: unknown = {}, headers: Record<string, string> = {}) => fetch(`${origin}${path}`, {
    method: "POST", headers: { origin, "content-type": "application/json", ...headers }, body: JSON.stringify(body), signal: AbortSignal.timeout(10_000),
  });
  const privateStatus = async (cookie: string) => (await fetch(`${origin}/private`, { headers: { cookie } })).status;
  const cookie = (response: Response) => response.headers.get("set-cookie")!.split(";")[0]!;
  try {
    await start();
    const password = "Correct horse battery staple";
    expect((await post("/enroll", { password })).status).toBe(403);
    expect((await post("/enroll", { password }, { "x-enroll": "authorized" })).status).toBe(200);
    expect((await post("/login", { password: "wrong" })).status).toBe(401);
    expect((await post("/login", { password }, { "x-deny-attempt": "true" })).status).toBe(429);
    expect((await post("/login", { password }, { origin: "https://untrusted.invalid" })).status).toBe(403);
    const login = await post("/login", { password });
    expect(login.status).toBe(200);
    let active = cookie(login);
    expect(await privateStatus(active)).toBe(200);
    await stop();
    await start();
    expect(await privateStatus(active)).toBe(200);
    const nextPassword = "Changed horse battery staple";
    expect((await post("/password", { current: password, next: nextPassword }, { cookie: active })).status).toBe(200);
    expect(await privateStatus(active)).toBe(401);
    expect((await post("/login", { password })).status).toBe(401);
    active = cookie(await post("/login", { password: nextPassword }));
    expect(await privateStatus(active)).toBe(200);
    expect((await post("/logout", {}, { cookie: active })).status).toBe(200);
    expect(await privateStatus(active)).toBe(401);
    const device = await authenticator(origin, "localhost");
    const registration = await (await post("/passkeys/register/options", {}, { "x-enroll": "authorized" })).json() as { challengeId: string; options: { challenge: string } };
    expect((await post("/passkeys/register", { challengeId: registration.challengeId, response: device.registration(registration.options.challenge) }, { "x-enroll": "authorized" })).status).toBe(200);
    await stop();
    await start();
    const authentication = await (await post("/passkeys/login/options")).json() as { challengeId: string; options: { challenge: string } };
    const body = { challengeId: authentication.challengeId, response: await device.authentication(authentication.options.challenge) };
    const passkeyLogin = await post("/passkeys/login", body);
    expect(passkeyLogin.status).toBe(200);
    expect(await privateStatus(cookie(passkeyLogin))).toBe(200);
    expect((await post("/passkeys/login", body)).status).toBe(400);
  } finally {
    await stop();
    await rm(directory, { recursive: true, force: true });
  }
}, 30_000);
