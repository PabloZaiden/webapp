/**
 * Serializable delegation policy, without server handlers or principals.
 */

export interface RouteResourceReference {
  source: "param" | "query" | "body";
  name: string;
  resource: string;
}

export interface RouteDelegationMetadata {
  resource: string;
  action: string;
  bindings?: readonly RouteResourceReference[];
  collection?: boolean;
}
