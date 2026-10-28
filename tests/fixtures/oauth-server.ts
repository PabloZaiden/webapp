import { createWebAppServer, jsonResponse, sqliteWebAppStore, type RuntimeConfig, type WebAppServer } from "../../src/server";
import { createUserRecord } from "../../src/server/auth/users";

const directory = process.argv[2]!;
const store = sqliteWebAppStore({ dataDir: directory });
store.initialize();
let user = store.getUserByUsername("human");
if (!user) {
  user = createUserRecord({ username: "human", role: "user" });
  store.createUser(user);
}
let app: WebAppServer | undefined;
const server = Bun.serve({
  hostname: "127.0.0.1", port: Number(process.argv[3] ?? 0),
  fetch: async request => await app?.handleRequest(request) ?? new Response(null, { status: 503 }),
});
const base = server.url.origin;
const runtime: RuntimeConfig = {
  appName: "Restart", envPrefix: "OAUTH_RESTART_TEST", host: "127.0.0.1", port: server.port!,
  dataDir: directory, logLevel: "error", logLevelFromEnv: false,
  passkeyDisabled: false, sameOriginDisabled: false,
  trustProxy: { enabled: false, headers: [], chain: "first" }, development: false,
};
app = createWebAppServer({
  appName: runtime.appName, envPrefix: runtime.envPrefix, runtimeConfig: runtime, store, web: false,
  auth: {
    oauth: {
      issuer: `${base}/identity`, resource: `${base}/mcp`, scopes: { control: "Control" },
      clients: [{
        clientId: "desktop", clientName: "Desktop", redirectUris: ["http://127.0.0.1:7777/callback"],
        grantTypes: ["authorization_code", "refresh_token"],
      }],
      consentPath: "/consent",
      authorizeConsent: () => ({ authorizationContext: { approved: true } }),
      handleResource: (_request, principal) => jsonResponse({ userId: principal.user.id }),
    },
  },
});
process.on("SIGTERM", async () => {
  await app!.stop(true);
  await server.stop(true);
  process.exit(0);
});
console.log(JSON.stringify({ base, port: server.port }));
