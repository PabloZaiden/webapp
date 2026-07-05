import { mkdirSync, rmSync } from "node:fs";
import { chromium, type Page } from "playwright";
import { sqliteWebAppStore } from "../src/server/auth/sqlite-store";

const outDir = "artifacts/screenshots";
const dataRoot = ".cache/screenshots";
mkdirSync(outDir, { recursive: true });
rmSync(dataRoot, { recursive: true, force: true });
mkdirSync(dataRoot, { recursive: true });

type ServerProcess = ReturnType<typeof Bun.spawn>;

function startExample(name: "notes-todo" | "kitchen-sink", port: number): ServerProcess {
  const prefix = name === "notes-todo" ? "NOTES_TODO" : "KITCHEN_SINK";
  const dataDir = `../../${dataRoot}/${name}`;
  const store = sqliteWebAppStore({ dataDir: `${dataRoot}/${name}` });
  store.initialize();
  const now = new Date().toISOString();
  const ownerId = `${name}-owner`;
  store.createUser({
    id: ownerId,
    username: "owner",
    role: "owner",
    authVersion: 1,
    passkeyConfigured: false,
    createdAt: now,
    updatedAt: now,
  });
  store.savePasskey({
    id: `${name}-owner-passkey`,
    userId: ownerId,
    name: "Screenshot passkey",
    credentialId: `${name}-owner-credential`,
    publicKey: new Uint8Array([1, 2, 3]) as Uint8Array<ArrayBuffer>,
    counter: 0,
    deviceType: "singleDevice",
    backedUp: false,
    transports: [],
    createdAt: now,
    updatedAt: now,
  });
  return Bun.spawn(["bun", "src/index.ts", "serve"], {
    cwd: `examples/${name}`,
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...process.env,
      [`${prefix}_PORT`]: String(port),
      [`${prefix}_DATA_DIR`]: dataDir,
      [`${prefix}_DISABLE_PASSKEY`]: "true",
    },
  });
}

async function waitForHealth(port: number): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://localhost:${port}/api/health`);
      if (response.ok) return;
    } catch {
      // Server is still starting.
    }
    await Bun.sleep(250);
  }
  throw new Error(`Server on ${port} did not become healthy`);
}

async function assertPublicRoute(port: number, path: string, contentType: string, expectedText: string): Promise<void> {
  const response = await fetch(`http://localhost:${port}${path}`);
  const body = await response.text();
  if (!response.ok || !response.headers.get("content-type")?.includes(contentType) || !body.includes(expectedText)) {
    throw new Error(`Public route ${path} on ${port} failed: ${response.status} ${response.headers.get("content-type")} ${body.slice(0, 120)}`);
  }
}

async function capture(page: Page, name: string): Promise<void> {
  await page.waitForTimeout(350);
  await page.screenshot({ path: `${outDir}/${name}.png`, fullPage: true });
}

async function assertNoHorizontalOverflow(page: Page, label: string): Promise<void> {
  const result = await page.evaluate(() => {
    const main = document.querySelector(".wapp-main-content");
    return {
      viewportWidth: window.innerWidth,
      documentWidth: document.documentElement.scrollWidth,
      mainClientWidth: main?.clientWidth ?? 0,
      mainScrollWidth: main?.scrollWidth ?? 0,
    };
  });
  if (result.documentWidth > result.viewportWidth + 1 || result.mainScrollWidth > result.mainClientWidth + 1) {
    throw new Error(`${label} has horizontal overflow: ${JSON.stringify(result)}`);
  }
}

const notes = startExample("notes-todo", 3301);
const kitchen = startExample("kitchen-sink", 3302);

try {
  await Promise.all([waitForHealth(3301), waitForHealth(3302)]);
  await Promise.all([
    assertPublicRoute(3301, "/site.webmanifest", "application/manifest+json", "Notes TODO"),
    assertPublicRoute(3301, "/public/onboarding.txt", "text/plain", "title-bar action menus"),
    assertPublicRoute(3302, "/site.webmanifest", "application/manifest+json", "Kitchen Sink"),
    assertPublicRoute(3302, "/public/diagnostics.json", "application/json", "\"publicRoute\":true"),
    assertPublicRoute(3302, "/robots.txt", "text/plain", "User-agent"),
  ]);
  const device = await fetch("http://localhost:3302/api/auth/device", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ client_id: "screenshot-cli", scope: "read" }),
  }).then((response) => response.json()) as { verification_uri_complete: string };

  const browser = await chromium.launch({ headless: true });
  try {
    const desktopLight = await browser.newPage({ viewport: { width: 1440, height: 920 }, colorScheme: "light" });
    await desktopLight.goto("http://localhost:3301/", { waitUntil: "domcontentloaded" });
    await capture(desktopLight, "notes-desktop-light");
    await desktopLight.goto("http://localhost:3301/#/settings", { waitUntil: "domcontentloaded" });
    await capture(desktopLight, "notes-settings-desktop-light");
    await desktopLight.close();

    const notesDark = await browser.newPage({ viewport: { width: 1440, height: 920 }, colorScheme: "dark" });
    await notesDark.goto("http://localhost:3301/#/settings", { waitUntil: "domcontentloaded" });
    await capture(notesDark, "notes-desktop-dark");
    await notesDark.close();

    const notesMobile = await browser.newPage({ viewport: { width: 390, height: 844 }, colorScheme: "light" });
    await notesMobile.goto("http://localhost:3301/", { waitUntil: "domcontentloaded" });
    await assertNoHorizontalOverflow(notesMobile, "notes-mobile-light");
    await capture(notesMobile, "notes-mobile-light");
    await notesMobile.locator(".wapp-shell").evaluate((element) => element.classList.add("sidebar-open"));
    await capture(notesMobile, "notes-mobile-sidebar-light");
    await notesMobile.close();

    const kitchenLight = await browser.newPage({ viewport: { width: 1440, height: 920 }, colorScheme: "light" });
    await kitchenLight.goto("http://localhost:3302/", { waitUntil: "domcontentloaded" });
    await capture(kitchenLight, "kitchen-desktop-light");
    await kitchenLight.getByLabel("Collapse sidebar").click();
    await capture(kitchenLight, "kitchen-sidebar-collapsed-light");
    await kitchenLight.close();

    const kitchenContext = await browser.newPage({ viewport: { width: 1440, height: 920 }, colorScheme: "light" });
    await kitchenContext.goto("http://localhost:3302/#/project?projectId=alpha", { waitUntil: "domcontentloaded" });
    await kitchenContext.locator(".wapp-sidebar-item", { hasText: "Alpha" }).first().click({ button: "right" });
    await capture(kitchenContext, "kitchen-context-menu-light");
    await kitchenContext.close();

    const kitchenDark = await browser.newPage({ viewport: { width: 1440, height: 920 }, colorScheme: "dark" });
    await kitchenDark.goto("http://localhost:3302/#/settings", { waitUntil: "domcontentloaded" });
    await kitchenDark.getByRole("button", { name: "Create API key" }).click();
    await kitchenDark.locator(".wapp-settings-row", { hasText: "API keys" }).getByRole("button", { name: "Delete" }).first().click();
    await capture(kitchenDark, "kitchen-dialog-dark");
    await kitchenDark.close();

    const kitchenMobile = await browser.newPage({ viewport: { width: 390, height: 844 }, colorScheme: "light" });
    await kitchenMobile.goto("http://localhost:3302/", { waitUntil: "domcontentloaded" });
    await assertNoHorizontalOverflow(kitchenMobile, "kitchen-mobile-light");
    await capture(kitchenMobile, "kitchen-mobile-light");
    await kitchenMobile.close();

    const devicePage = await browser.newPage({ viewport: { width: 720, height: 760 }, colorScheme: "light" });
    await devicePage.goto(device.verification_uri_complete, { waitUntil: "domcontentloaded" });
    await capture(devicePage, "kitchen-device-light");
    await devicePage.close();
  } finally {
    await browser.close();
  }
} finally {
  notes.kill();
  kitchen.kill();
}
