type NetworkFailureListener = (request: Request, error: TypeError) => void;

const listeners = new Set<NetworkFailureListener>();

export function onNetworkFailure(listener: NetworkFailureListener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function report(request: Request, error: unknown): void {
  if (error instanceof TypeError && !request.signal.aborted) {
    for (const listener of listeners) listener(request, error);
  }
}

/** Keep fetch metadata and header immutability while monitoring the body stream. */
class NetworkResponse extends Response {
  constructor(body: ReadableStream<Uint8Array>, private readonly source: Response) {
    super(body, { status: source.status, statusText: source.statusText, headers: source.headers });
  }

  override get url(): string { return this.source.url; }
  override get type(): ResponseType { return this.source.type; }
  override get redirected(): boolean { return this.source.redirected; }
  override get headers(): Headers { return this.source.headers; }

  override clone(): Response {
    return new NetworkResponse(super.clone().body!, this.source);
  }
}

function monitorBody(response: Response, request: Request): Response {
  if (!response.ok || !response.body) return response;
  const reader = response.body.getReader();
  let finished = false;
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      let result: Awaited<ReturnType<typeof reader.read>>;
      try {
        result = await reader.read();
      } catch (error) {
        if (!finished) {
          finished = true;
          reader.releaseLock();
          report(request, error);
          controller.error(error);
        }
        return;
      }
      if (finished) return;
      if (result.done) {
        finished = true;
        reader.releaseLock();
        controller.close();
      } else {
        controller.enqueue(result.value);
      }
    },
    async cancel(reason) {
      finished = true;
      try {
        await reader.cancel(reason);
      } finally {
        reader.releaseLock();
      }
    },
  }, { highWaterMark: 0 });
  return new NetworkResponse(body, response);
}

export async function fetchAppRequest(request: Request): Promise<Response> {
  let response: Response;
  try {
    response = await fetch(request);
  } catch (error) {
    report(request, error);
    throw error;
  }
  return monitorBody(response, request);
}
