import { startRegistration } from "@simplewebauthn/browser";
import { useCallback, useState } from "react";
import type { ApiKeySummary, CreatedApiKeyResponse, WebAppConfigResponse } from "../../contracts";
import { appJson } from "../api-client";
import { Button, ConfirmDialog, EmptyState } from "../components";
import { useLiveQuery } from "../realtime/useRealtime";
import { ResourceState } from "./resource-state";

export interface SecuritySectionProps {
  config: WebAppConfigResponse;
  refresh: () => Promise<void>;
  setError: (error: string | undefined) => void;
}

export function SecuritySection({ config, refresh, setError }: SecuritySectionProps) {
  const [createdToken, setCreatedToken] = useState<string>();
  const [apiKeyToDelete, setApiKeyToDelete] = useState<ApiKeySummary>();
  const [confirmDeletePasskey, setConfirmDeletePasskey] = useState(false);

  const loadApiKeys = useCallback(
    () => config.apiKeys.enabled
      ? appJson<ApiKeySummary[]>("/api/api-keys")
      : Promise.resolve<ApiKeySummary[]>([]),
    [config.apiKeys.enabled],
  );
  const { data: apiKeys, error: apiKeysLoadError, loading: apiKeysLoading, refresh: refreshApiKeys } = useLiveQuery<ApiKeySummary[]>({ load: loadApiKeys, realtime: false });

  async function createKey() {
    const result = await appJson<CreatedApiKeyResponse>("/api/api-keys", { method: "POST", body: JSON.stringify({ name: "Browser key", scopes: ["*"] }) });
    setCreatedToken(result.token);
    await refreshApiKeys();
  }

  async function deleteKey(id: string) {
    try {
      setError(undefined);
      await appJson(`/api/api-keys/${encodeURIComponent(id)}`, { method: "DELETE" });
      setApiKeyToDelete(undefined);
      await refreshApiKeys();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function setupPasskey() {
    try {
      setError(undefined);
      const options = await appJson<PublicKeyCredentialCreationOptionsJSON>("/api/passkey-auth/owner-setup/options", { method: "POST", body: "{}" });
      const credential = await startRegistration({ optionsJSON: options as never });
      await appJson("/api/passkey-auth/owner-setup/verify", { method: "POST", body: JSON.stringify(credential) });
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function logout() {
    await appJson("/api/passkey-auth/logout", { method: "POST", body: "{}" });
    await refresh();
  }

  async function deleteConfiguredPasskey() {
    await appJson("/api/passkey-auth/passkey", { method: "DELETE" });
    setConfirmDeletePasskey(false);
    await refresh();
  }

  return (
    <>
      <div className="wapp-settings-row">
        <div>
          <strong>Passkey</strong>
          <p>{config.passkeyAuth.passkeyConfigured ? "Your passkey protects this account." : "No passkey configured yet."}</p>
        </div>
        <div className="wapp-row-actions">
          {config.passkeyAuth.passkeyConfigured ? (
            <>
              <Button type="button" onClick={() => void logout()}>Logout</Button>
              <Button type="button" variant="danger" onClick={() => setConfirmDeletePasskey(true)}>Delete passkey</Button>
            </>
          ) : (
            config.currentUser?.isOwner ? <Button type="button" variant="primary" onClick={() => void setupPasskey()}>Set up passkey</Button> : null
          )}
        </div>
      </div>
      {config.apiKeys.enabled ? (
        <>
          <div className="wapp-settings-row">
            <div className="wapp-settings-row-main">
              <strong>API keys</strong>
              <p>Create bearer tokens for scripts and agents.</p>
            </div>
            <div className="wapp-row-actions"><Button type="button" onClick={() => void createKey().catch((err) => setError(String(err)))}>Create API key</Button></div>
          </div>
          <div className="wapp-settings-row-content">
            {createdToken ? <code className="wapp-token">{createdToken}</code> : null}
            <ResourceState loading={apiKeysLoading} error={apiKeysLoadError} hasData={apiKeys !== undefined} refresh={refreshApiKeys} />
            {apiKeys?.length ? (
              <div className="wapp-list">
                {apiKeys.map((key) => (
                  <div className="wapp-list-row" key={key.id}>
                    <span><strong>{key.name}</strong><small>{key.scopes.join(", ")} · {key.createdAt}</small></span>
                    <Button type="button" variant="danger" onClick={() => setApiKeyToDelete(key)}>Delete</Button>
                  </div>
                ))}
              </div>
            ) : apiKeys !== undefined && !apiKeysLoadError ? <EmptyState title="No API keys" /> : null}
          </div>
        </>
      ) : null}
      <ConfirmDialog
        open={Boolean(apiKeyToDelete)}
        title="Delete API key?"
        message={apiKeyToDelete ? `This permanently deletes "${apiKeyToDelete.name}". Scripts and agents using this token will stop working.` : ""}
        confirmLabel="Delete API key"
        danger
        onCancel={() => setApiKeyToDelete(undefined)}
        onConfirm={() => apiKeyToDelete && void deleteKey(apiKeyToDelete.id)}
      />
      <ConfirmDialog open={confirmDeletePasskey} title="Delete passkey?" message="This removes the configured passkey and invalidates browser sessions." confirmLabel="Delete passkey" danger onCancel={() => setConfirmDeletePasskey(false)} onConfirm={() => void deleteConfiguredPasskey()} />
    </>
  );
}
