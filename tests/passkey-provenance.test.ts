import { expect, test } from "bun:test";
import { isoCBOR } from "@simplewebauthn/server/helpers";
import type { AuthenticationResponseJSON, RegistrationResponseJSON } from "@simplewebauthn/server";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createWebAppServer, defineRoutes, memoryWebAppStore, type RuntimeConfig } from "@pablozaiden/webapp/server";
import { createBrowserSessionHeaders } from "../src/server/auth/passkeys";

function base64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64url");
}

async function authenticator(origin: string, rpId: string) {
  const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  const publicKey = new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey));
  const credential = crypto.getRandomValues(new Uint8Array(32));
  const rpHash = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(rpId)));
  const clientData = (challenge: string, type: string) => Buffer.from(JSON.stringify({ type, challenge, origin, crossOrigin: false }));
  return {
    registration(challenge: string): RegistrationResponseJSON {
      const key = new Map<number, number | Uint8Array>([
        [1, 2], [3, -7], [-1, 1], [-2, publicKey.slice(1, 33)], [-3, publicKey.slice(33)],
      ]);
      const data = Buffer.concat([
        rpHash, new Uint8Array([0x45]), new Uint8Array(4), new Uint8Array(16),
        new Uint8Array([0, credential.length]), credential, isoCBOR.encode(key),
      ]);
      return {
        id: base64(credential), rawId: base64(credential), type: "public-key",
        response: {
          clientDataJSON: base64(clientData(challenge, "webauthn.create")),
          attestationObject: base64(isoCBOR.encode(new Map<string, string | Map<never, never> | Uint8Array>([
            ["fmt", "none"], ["attStmt", new Map<never, never>()], ["authData", data],
          ]))),
          transports: ["internal"],
        },
        authenticatorAttachment: "platform", clientExtensionResults: {},
      };
    },
    async authentication(challenge: string): Promise<AuthenticationResponseJSON> {
      const data = Buffer.concat([rpHash, new Uint8Array([0x05]), new Uint8Array([0, 0, 0, 1])]);
      const client = clientData(challenge, "webauthn.get");
      const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", client));
      const raw = new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, pair.privateKey, Buffer.concat([data, hash])));
      const integer = (part: Uint8Array) => {
        const start = part.findIndex((byte) => byte !== 0);
        const value = part.slice(start < 0 ? part.length - 1 : start);
        const padded = value[0]! >= 0x80 ? Buffer.concat([new Uint8Array([0]), value]) : value;
        return Buffer.concat([new Uint8Array([2, padded.length]), padded]);
      };
      const content = Buffer.concat([integer(raw.slice(0, 32)), integer(raw.slice(32))]);
      return {
        id: base64(credential), rawId: base64(credential), type: "public-key", clientExtensionResults: {},
        response: { authenticatorData: base64(data), clientDataJSON: base64(client),
          signature: base64(Buffer.concat([new Uint8Array([0x30, content.length]), content])) },
      };
    },
  };
}

// Required authorization boundary: only a completed WebAuthn ceremony grants
// access to passkey-only application operations; ordinary browser login remains usable.
test("passkey-only HTTP operations distinguish verified WebAuthn from other browser sessions", async () => {
  const directory = await mkdtemp(join(tmpdir(), "webapp-provenance-"));
  const store = memoryWebAppStore();
  const config: RuntimeConfig = {
    appName: "Passkey provenance", envPrefix: "PASSKEY_PROVENANCE", dataDir: directory,
    host: "127.0.0.1", port: 0, logLevel: "error", logLevelFromEnv: false,
    passkeyDisabled: false, sameOriginDisabled: false,
    trustProxy: { enabled: false, headers: [], chain: "first" }, development: false,
  };
  const makeApp = (runtimeConfig: RuntimeConfig) => createWebAppServer({
    appName: config.appName, envPrefix: config.envPrefix, runtimeConfig, store, web: false,
    auth: { passkeys: true, apiKeys: true },
    routes: defineRoutes({
      "/api/passkey-only": {
        auth: "user", sameOrigin: "always",
        POST(_request, context) {
          return new Response(null, { status: context.auth.kind === "passkey" && context.auth.passkeyId ? 204 : 403 });
        },
      },
      "/api/ordinary": { auth: "user", sameOrigin: "always", POST: () => new Response(null, { status: 204 }) },
    }),
  });
  let app = makeApp(config);
  const cookies = new Map<string, string>();
  const absorb = (response: Response) => {
    for (const header of response.headers.getSetCookie()) {
      const pair = header.split(";", 1)[0]!;
      const separator = pair.indexOf("=");
      cookies.set(pair.slice(0, separator), pair.slice(separator + 1));
    }
  };
  const cookie = () => [...cookies].map(([key, value]) => `${key}=${value}`).join("; ");
  try {
    let server = await app.start();
    let origin = `http://localhost:${server.port}`;
    const request = async (path: string, body: unknown, session = cookie(), method = "POST") => {
      const response = await fetch(origin + path, { method,
        headers: { origin, cookie: session, "content-type": "application/json" },
        ...(method === "DELETE" ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(5000) });
      absorb(response);
      return response;
    };
    const options = await request("/api/passkey-auth/bootstrap/options", { username: "owner" });
    expect(options.status).toBe(200);
    const registration = await options.json() as { challenge: string; rp: { id: string } };
    const device = await authenticator(origin, registration.rp.id);
    expect((await request("/api/passkey-auth/bootstrap/verify", device.registration(registration.challenge))).status).toBe(200);
    expect((await request("/api/passkey-only", {})).status).toBe(204);
    const verifiedCookie = cookie();

    const issued = await request("/api/api-keys", { name: "Browser sign-in", scopes: ["*"] });
    expect(issued.status).toBe(200);
    const key = await issued.json() as { token: string };
    expect((await request("/api/passkey-auth/api-key", { apiKey: key.token }, "")).status).toBe(200);
    expect((await request("/api/ordinary", {})).status).toBe(204);
    expect((await request("/api/passkey-only", {})).status).toBe(403);

    const owner = store.getOwnerUser();
    if (!owner) throw new Error("Missing registered owner.");
    const legacy = createBrowserSessionHeaders(new Request(origin), store, config, owner)
      .getSetCookie().map((header) => header.split(";", 1)[0]!).join("; ");
    expect((await request("/api/ordinary", {}, legacy)).status).toBe(204);
    expect((await request("/api/passkey-only", {}, legacy)).status).toBe(403);

    const optionsResponse = await request("/api/passkey-auth/authentication/options", {});
    expect(optionsResponse.status).toBe(200);
    const authentication = await optionsResponse.json() as { challenge: string };
    expect((await request("/api/passkey-auth/authentication/verify", await device.authentication(authentication.challenge))).status).toBe(200);
    expect((await request("/api/passkey-only", {})).status).toBe(204);
    const authenticatedCookie = cookie();
    expect((await request("/api/passkey-auth/passkey", undefined, authenticatedCookie, "DELETE")).status).toBe(200);
    for (const removed of [verifiedCookie, authenticatedCookie]) {
      expect((await request("/api/passkey-only", {}, removed)).status).toBe(401);
    }

    await app.stop(true);
    app = makeApp({ ...config, passkeyDisabled: true });
    server = await app.start();
    origin = `http://localhost:${server.port}`;
    expect((await request("/api/ordinary", {}, "")).status).toBe(204);
    expect((await request("/api/passkey-only", {}, "")).status).toBe(403);
  } finally {
    await app.stop(true);
    await rm(directory, { recursive: true, force: true });
  }
});
