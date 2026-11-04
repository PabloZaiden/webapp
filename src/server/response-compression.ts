import { createLogger } from "./logger";

const MIN_COMPRESSION_BYTES = 1024;
const log = createLogger("webapp:compression");
const ENTITY_TAG = '(?:W/)?"[\\x21\\x23-\\x7e\\x80-\\xff]*"';
const ENTITY_TAG_LIST = new RegExp(`^${ENTITY_TAG}(?:\\s*,\\s*${ENTITY_TAG})*$`);

function acceptsGzip(request: Request): boolean {
  let gzip: number | undefined;
  let wildcard = 0;
  let identity: number | undefined;
  for (const entry of (request.headers.get("accept-encoding") ?? "").split(",")) {
    const [encoding, ...parameters] = entry.toLowerCase().split(";").map(token => token.trim());
    if (encoding !== "gzip" && encoding !== "*" && encoding !== "identity") continue;
    let quality = 1;
    for (const parameter of parameters) {
      const match = /^\s*q\s*=\s*(0(?:\.\d{0,3})?|1(?:\.0{0,3})?)\s*$/.exec(parameter);
      if (!match) { quality = 0; break; }
      quality = Number(match[1]);
    }
    if (encoding === "gzip") gzip = quality;
    else if (encoding === "*") wildcard = quality;
    else identity = quality;
  }
  const quality = gzip ?? wildcard;
  return quality > 0 && (identity === undefined || quality >= identity);
}

function addEncodingVary(headers: Headers): void {
  const vary = headers.get("vary");
  if (vary?.split(",").some(value => ["*", "accept-encoding"].includes(value.trim().toLowerCase()))) return;
  headers.set("vary", vary ? `${vary}, Accept-Encoding` : "Accept-Encoding");
}

function weakEtag(headers: Headers): void {
  const etag = headers.get("etag");
  if (etag?.startsWith('"')) headers.set("etag", `W/${etag}`);
}

function matchesEtag(request: Request, headers: Headers): boolean {
  const etag = headers.get("etag");
  const condition = request.headers.get("if-none-match")?.trim();
  if (!etag || !condition) return false;
  if (condition === "*") return true;
  if (!ENTITY_TAG_LIST.test(condition)) return false;
  return [...condition.matchAll(new RegExp(ENTITY_TAG, "g"))]
    .some(match => match[0].replace(/^W\//, "") === etag.replace(/^W\//, ""));
}

function compressible(headers: Headers): boolean {
  const mime = headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() ?? "";
  return (mime.startsWith("text/") && mime !== "text/event-stream")
    || ["application/json", "application/javascript", "application/xml"].includes(mime)
    || mime.endsWith("+json") || mime.endsWith("+xml");
}

function responseWithBody(response: Response, body: BodyInit | null, headers: Headers): Response {
  return new Response(body, { status: response.status, statusText: response.statusText, headers });
}

/**
 * Probe only a small prefix, then let gzip stream with the consumer's backpressure.
 * The application may already hold a large JSON body; do not make another full copy.
 */
export async function compressResponse(request: Request, response: Response): Promise<Response> {
  if (!["GET", "HEAD"].includes(request.method)
    || response.status === 206
    || response.headers.has("content-range")
    || response.headers.has("content-encoding")
    || response.headers.has("content-disposition")
    || /(?:^|,)\s*no-transform\s*(?:,|$)/i.test(response.headers.get("cache-control") ?? "")) return response;

  const gzip = acceptsGzip(request);
  const headers = new Headers(response.headers);
  // A 304 often omits Content-Type. Its validators still describe the cached variant.
  if (response.status === 304 && !headers.has("content-type")) {
    addEncodingVary(headers);
    if (gzip) {
      weakEtag(headers);
      headers.delete("content-length");
    }
    return responseWithBody(response, null, headers);
  }
  if (!compressible(headers)) return response;
  addEncodingVary(headers);
  if (response.status === 200 && matchesEtag(request, headers)) {
    if (gzip) weakEtag(headers);
    headers.delete("content-length");
    void response.body?.cancel().catch(error => {
      log.error("Conditional response body cancellation failed", { error: String(error) });
    });
    return new Response(null, { status: 304, headers });
  }
  if (response.status === 304) {
    if (gzip) {
      weakEtag(headers);
      headers.delete("content-length");
    }
    return responseWithBody(response, null, headers);
  }
  const declaredLength = headers.get("content-length");
  if (gzip && request.method === "HEAD"
    && (declaredLength === null || Number(declaredLength) >= MIN_COMPRESSION_BYTES)) {
    headers.delete("content-length");
    weakEtag(headers);
  }
  if (!gzip || request.method === "HEAD" || !response.body
    || (declaredLength !== null && Number(declaredLength) < MIN_COMPRESSION_BYTES)) {
    return responseWithBody(response, response.body, headers);
  }

  const reader = response.body.getReader();
  const prefix: Uint8Array<ArrayBuffer>[] = [];
  let size = 0;
  let complete = false;
  try {
    while (size < MIN_COMPRESSION_BYTES) {
      const chunk = await reader.read();
      if (chunk.done) { complete = true; break; }
      prefix.push(chunk.value);
      size += chunk.value.byteLength;
    }
  } catch (error) {
    reader.releaseLock();
    throw error;
  }
  if (complete) reader.releaseLock();
  const body = new ReadableStream<Uint8Array<ArrayBuffer>>({
    start(controller) {
      for (const chunk of prefix) controller.enqueue(chunk);
      if (complete) controller.close();
    },
    async pull(controller) {
      try {
        const chunk = await reader.read();
        if (chunk.done) {
          reader.releaseLock();
          controller.close();
        } else {
          controller.enqueue(chunk.value);
        }
      } catch (error) {
        log.error("Response compression source failed", { error: String(error) });
        controller.error(error);
      }
    },
    async cancel(reason) {
      if (!complete) {
        try { await reader.cancel(reason); } finally { reader.releaseLock(); }
      }
    },
  });
  if (size < MIN_COMPRESSION_BYTES) return responseWithBody(response, body, headers);
  headers.set("content-encoding", "gzip");
  headers.delete("content-length");
  headers.delete("content-md5");
  headers.delete("content-digest");
  weakEtag(headers);
  return responseWithBody(response, body.pipeThrough(new CompressionStream("gzip")), headers);
}
