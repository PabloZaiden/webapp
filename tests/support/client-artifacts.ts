import { expect } from "bun:test";

/** Follow the public HTML, ESM and CSS graph through a real static/server listener. */
export async function fetchClientArtifacts(documentUrl: string): Promise<Map<string, string>> {
  const document = await fetch(documentUrl, { signal: AbortSignal.timeout(5_000) });
  expect(document.status).toBe(200);
  expect(document.headers.get("content-type")).toContain("text/html");
  const html = await document.text();
  const responses = new Map<string, string>([[documentUrl, html]]);
  const pending = Array.from(html.matchAll(/(?:src|href)="([^"]+)"/g), (match) => new URL(match[1]!, documentUrl).href);
  const transpiler = new Bun.Transpiler({ loader: "js" });
  while (pending.length > 0) {
    const url = pending.pop()!;
    if (responses.has(url)) continue;
    const response = await fetch(url, { signal: AbortSignal.timeout(5_000) });
    expect(response.status, url).toBe(200);
    const body = await response.text();
    responses.set(url, body);
    const contentType = response.headers.get("content-type") ?? "";
    if (contentType.includes("javascript")) {
      for (const dependency of transpiler.scanImports(body)) {
        pending.push(new URL(dependency.path, url).href);
      }
    } else if (contentType.includes("text/css")) {
      for (const match of body.matchAll(/url\(["']?([^"')]+)["']?\)/g)) {
        if (!match[1]!.startsWith("data:")) pending.push(new URL(match[1]!, url).href);
      }
    } else if (contentType.includes("manifest+json")) {
      const manifest = JSON.parse(body) as { icons: { src: string }[] };
      for (const icon of manifest.icons) pending.push(new URL(icon.src, url).href);
    }
  }
  return responses;
}
