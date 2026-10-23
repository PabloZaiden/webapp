export const DEFAULT_PARTIAL_RESULT_HEADER = "X-WebApp-Partial";

export interface PartialResultMetadata {
  /** Applications may choose a product-specific header without changing bodies. */
  header: string;
}

export interface WebAppResponseMetadata {
  partial: boolean;
}

export function readResponseMetadata(
  response: Pick<Response, "headers">,
  options?: PartialResultMetadata,
): WebAppResponseMetadata {
  return {
    partial: response.headers.get(options?.header ?? DEFAULT_PARTIAL_RESULT_HEADER)?.toLowerCase() === "true",
  };
}
