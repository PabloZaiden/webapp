# Server API

Use `createWebAppServer` with `defineRoutes`. Route patterns support exact path segments and `:params`.

```ts
const routes = defineRoutes<AppEvent>({
  "/api/projects": {
    GET: () => jsonResponse(projects),
    async POST(req, ctx) {
      const body = await parseJson<{ name: string }>(req);
      const project = createProject(body.name);
      ctx.realtime.publishEntityChanged("projects", project.id);
      return jsonResponse(project);
    },
  },
  "/api/projects/:id": {
    scopes: ["projects:write"],
    PATCH: updateProject,
  },
});
```

Route defaults are intentionally secure:

| Setting | Default | Meaning |
| --- | --- | --- |
| `auth` | `required` | Requires passkey session, API key or device bearer token once auth is configured |
| `sameOrigin` | `mutations` | Requires `Origin`/`Referer` for cookie/browser mutations |
| `scopes` | `[]` | Checked for API keys and device tokens; `*` grants all |

Set `auth: "public", sameOrigin: "never"` only for deliberate unauthenticated endpoints such as health probes, webhooks or callback receivers.

Built-in endpoints include:

| Endpoint | Purpose |
| --- | --- |
| `GET /api/health` | Health/version |
| `GET /api/config` | Safe framework config for UI |
| `/api/passkey-auth/*` | Passkey bootstrap/login/logout/delete |
| `/api/api-keys` | Browser-managed API key create/list/delete |
| `/api/auth/device`, `/api/auth/token`, `/api/auth/refresh`, `/api/auth/revoke` | Device auth and refresh-token flow |
| `/.well-known/jwks.json`, `/.well-known/openid-configuration` | Token verification metadata |
| `/api/preferences/theme`, `/api/preferences/log-level` | Settings persistence |
| `/api/server/kill` | Authenticated server shutdown |
| `/api/ws` | Realtime websocket by default |
