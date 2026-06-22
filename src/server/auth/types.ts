export interface AccessTokenClaims {
  sub: string;
  jti: string;
  sid: string;
  clientId: string;
  scope: string;
}

export type AuthenticatedRequestState =
  | { kind: "anonymous" }
  | { kind: "passkey"; passkeyId?: string }
  | { kind: "api-key"; apiKeyId: string; scopes: string[] }
  | { kind: "bearer"; claims: AccessTokenClaims };

export class AuthError extends Error {
  code: string;
  status: number;

  constructor(code: string, message: string, status: number) {
    super(message);
    this.name = "AuthError";
    this.code = code;
    this.status = status;
  }
}
