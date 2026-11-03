# Shell, Settings and explicit preferences

`WebAppRoot` owns framing, navigation, headers, dialogs and the Settings layout,
not account lifecycle. Apps decide whether to render their own login, account
or administration pages. `routes.settings` takes precedence over the generic
Settings view when an app needs a whole composition.

```tsx
<WebAppRoot
  appName="Example"
  homeRoute={{ view: "home" }}
  sidebar={{ getNodes: () => nodes }}
  routes={{ home: <Page>…</Page> }}
  settings={{ sections: [{
    id: "appearance",
    title: "Appearance",
    rows: [{ id: "theme", title: "Theme", content: <ThemeSelect /> }],
  }] }}
/>
```

Sections/rows have no mandatory role/scope presentation or visibility rules.
Filter app-owned sections in app code and enforce access on the server.
Structured rows take content, feedback and actions. Use `SettingsLayout`,
`SettingsSectionContent`, `SettingsFieldRow`, shared native forms and semantic
actions. Keep short fields content-sized and controls/actions right-aligned;
see [UI guidelines](ui-guidelines.md). Delete actions require `ConfirmDialog`.

## Persistence

All UI preferences default to memory: theme, sidebar pins/collapse/tabs and
remembered Settings category. Core code never selects localStorage,
sessionStorage or IndexedDB automatically.

Before rendering, apps may explicitly select:

```ts
configureWebAppPreferences({
  adapter: createBrowserPreferenceAdapter(),
  scope: () => currentClientPreferenceNamespace,
  themeStorageKey: "webapp.theme",
});
initializeWebAppTheme();
```

`WebAppPreferenceAdapter` has synchronous `getItem`, `setItem`, `removeItem`.
The browser adapter accesses only its explicitly selected Storage.
If browser policy denies access with a SecurityError, it reports the failure and
uses memory-only preferences so startup remains usable.
`clientScopedStorageKey` retains the `:client:<encoded-scope>` format; an empty
scope leaves keys unchanged. Apps preserve prior namespaces rather than
inventing migration keys. Scope defaults to the current neutral runtime.
`themeStorageKey` may also be a function. Do not add a hidden persistence
provider or a second app-owned preference queue.

Generated documents prepaint Dark without reading storage. The selected
adapter is used by `initializeWebAppTheme` before React renders and by hooks.
Dark is the default without a saved value; Light and System remain available.
Apps selecting an adapter in their frontend initializer should call
`initializeWebAppTheme` after selection as well.

## Optional server synchronization

`WebAppRoot.theme` or `ThemeProvider.adapter` accepts an app-owned
`{load():Promise<ThemePreference>,save(value):Promise<void>,storageKey?:string}`.
There is no implicit preference HTTP endpoint. `storageKey` is an optional
exact key override; otherwise `webapp.theme` uses selected client scoping.
`useTheme()` exposes preference, resolvedTheme, setPreference, savePreference,
loading/error/retry. Reuse it for app logic instead of observing root DOM.

`useLogLevel()` reflects the supplied runtime's level and optional environment
lock metadata. Apps update their own preference/server state and publish a new
runtime snapshot; framework UI does not fetch account configuration.

Changing the runtime's scope/generation retires transport work and remounts
route content so one client's state cannot cross identities or endpoints.
Apps own their authentication controls and any app caches outside the frame.
