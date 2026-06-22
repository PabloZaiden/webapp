import { mkdirSync, rmSync } from "node:fs";
import { chromium, type Page } from "playwright";

const outDir = "artifacts/screenshots";
const dataRoot = ".cache/screenshots";
mkdirSync(outDir, { recursive: true });
rmSync(dataRoot, { recursive: true, force: true });
mkdirSync(dataRoot, { recursive: true });

type ServerProcess = ReturnType<typeof Bun.spawn>;

function startExample(name: "notes-todo" | "kitchen-sink", port: number): ServerProcess {
  const prefix = name === "notes-todo" ? "NOTES_TODO" : "KITCHEN_SINK";
  return Bun.spawn(["bun", "src/index.ts", "serve"], {
    cwd: `examples/${name}`,
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...process.env,
      [`${prefix}_PORT`]: String(port),
      [`${prefix}_DATA_DIR`]: `../../${dataRoot}/${name}`,
      [`${prefix}_DISABLE_PASSKEY`]: "true",
    },
  });
}

async function waitForHealth(port: number): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/health`);
      if (response.ok) return;
    } catch {
      // Server is still starting.
    }
    await Bun.sleep(250);
  }
  throw new Error(`Server on ${port} did not become healthy`);
}

async function capture(page: Page, name: string): Promise<void> {
  await page.waitForTimeout(350);
  await page.screenshot({ path: `${outDir}/${name}.png`, fullPage: true });
}

const notes = startExample("notes-todo", 3301);
const kitchen = startExample("kitchen-sink", 3302);

try {
  await Promise.all([waitForHealth(3301), waitForHealth(3302)]);
  const device = await fetch("http://127.0.0.1:3302/api/auth/device", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ client_id: "screenshot-cli", scope: "read" }),
  }).then((response) => response.json()) as { verification_uri_complete: string };

  const browser = await chromium.launch({ headless: true });
  try {
    const desktopLight = await browser.newPage({ viewport: { width: 1440, height: 920 }, colorScheme: "light" });
    await desktopLight.goto("http://127.0.0.1:3301/", { waitUntil: "domcontentloaded" });
    await capture(desktopLight, "notes-desktop-light");
    await desktopLight.goto("http://127.0.0.1:3301/#/settings", { waitUntil: "domcontentloaded" });
    await capture(desktopLight, "notes-settings-desktop-light");
    await desktopLight.close();

    const notesDark = await browser.newPage({ viewport: { width: 1440, height: 920 }, colorScheme: "dark" });
    await notesDark.goto("http://127.0.0.1:3301/#/settings", { waitUntil: "domcontentloaded" });
    await capture(notesDark, "notes-desktop-dark");
    await notesDark.close();

    const notesMobile = await browser.newPage({ viewport: { width: 390, height: 844 }, colorScheme: "light" });
    await notesMobile.goto("http://127.0.0.1:3301/", { waitUntil: "domcontentloaded" });
    await capture(notesMobile, "notes-mobile-light");
    await notesMobile.getByLabel("Show sidebar").click();
    await capture(notesMobile, "notes-mobile-sidebar-light");
    await notesMobile.close();

    const kitchenLight = await browser.newPage({ viewport: { width: 1440, height: 920 }, colorScheme: "light" });
    await kitchenLight.goto("http://127.0.0.1:3302/", { waitUntil: "domcontentloaded" });
    await capture(kitchenLight, "kitchen-desktop-light");
    await kitchenLight.getByLabel("Collapse sidebar").click();
    await capture(kitchenLight, "kitchen-sidebar-collapsed-light");
    await kitchenLight.close();

    const kitchenContext = await browser.newPage({ viewport: { width: 1440, height: 920 }, colorScheme: "light" });
    await kitchenContext.goto("http://127.0.0.1:3302/#/project?projectId=alpha", { waitUntil: "domcontentloaded" });
    await kitchenContext.locator(".wapp-sidebar-item", { hasText: "Alpha" }).first().click({ button: "right" });
    await capture(kitchenContext, "kitchen-context-menu-light");
    await kitchenContext.close();

    const kitchenDark = await browser.newPage({ viewport: { width: 1440, height: 920 }, colorScheme: "dark" });
    await kitchenDark.goto("http://127.0.0.1:3302/#/settings", { waitUntil: "domcontentloaded" });
    await kitchenDark.getByRole("button", { name: "Create API key" }).click();
    await kitchenDark.getByRole("button", { name: "Delete" }).click();
    await capture(kitchenDark, "kitchen-dialog-dark");
    await kitchenDark.close();

    const kitchenMobile = await browser.newPage({ viewport: { width: 390, height: 844 }, colorScheme: "light" });
    await kitchenMobile.goto("http://127.0.0.1:3302/", { waitUntil: "domcontentloaded" });
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
