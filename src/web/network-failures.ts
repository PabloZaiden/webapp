type NetworkFailureListener = (request: Request, error: TypeError) => void;

const listeners = new Set<NetworkFailureListener>();

export function onNetworkFailure(listener: NetworkFailureListener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export async function fetchAppRequest(request: Request): Promise<Response> {
  try {
    return await fetch(request);
  } catch (error) {
    if (error instanceof TypeError && !request.signal.aborted) {
      for (const listener of listeners) listener(request, error);
    }
    throw error;
  }
}
