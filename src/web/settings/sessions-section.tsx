import { useCallback, useState } from "react";
import type { AuthSessionSummary, WebAppConfigResponse } from "../../contracts";
import { appJson } from "../api-client";
import { Button, ConfirmDialog, EmptyState } from "../components";
import { useLiveQuery } from "../realtime/useRealtime";
import { ResourceState } from "./resource-state";

export interface SessionsSectionProps {
  config: WebAppConfigResponse;
  setError: (error: string | undefined) => void;
}

export function SessionsSection({ config, setError }: SessionsSectionProps) {
  const [authSessionToRevoke, setAuthSessionToRevoke] = useState<AuthSessionSummary>();

  const loadAuthSessions = useCallback(
    () => config.deviceAuth.enabled
      ? appJson<AuthSessionSummary[]>("/api/auth/sessions")
      : Promise.resolve<AuthSessionSummary[]>([]),
    [config.deviceAuth.enabled],
  );
  const { data: authSessions, error: authSessionsLoadError, loading: authSessionsLoading, refresh: refreshAuthSessions } = useLiveQuery<AuthSessionSummary[]>({ load: loadAuthSessions, realtime: false });

  async function revokeAuthSession(session: AuthSessionSummary) {
    try {
      setError(undefined);
      await appJson(`/api/auth/sessions/${session.id}`, { method: "DELETE" });
      setAuthSessionToRevoke(undefined);
      await refreshAuthSessions();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  if (!config.deviceAuth.enabled) {
    return null;
  }
  return (
    <>
      <div className="wapp-settings-row stacked">
        <div>
          <strong>Device auth sessions</strong>
          <p>Refresh-token sessions created through the device flow.</p>
        </div>
        <ResourceState loading={authSessionsLoading} error={authSessionsLoadError} hasData={authSessions !== undefined} refresh={refreshAuthSessions} />
        <div className="wapp-list">
          {authSessions?.length ? authSessions.map((session) => (
            <div className="wapp-list-row" key={session.id}>
              <span><strong>{session.clientId}</strong><small>{session.scope} · {session.updatedAt}</small></span>
              <Button type="button" variant="danger" onClick={() => setAuthSessionToRevoke(session)}>Revoke</Button>
            </div>
          )) : authSessions !== undefined && !authSessionsLoadError ? <EmptyState title="No device sessions" /> : null}
        </div>
      </div>
      <ConfirmDialog
        open={Boolean(authSessionToRevoke)}
        title="Revoke device session?"
        message={authSessionToRevoke ? `This revokes the active "${authSessionToRevoke.clientId}" refresh-token session.` : ""}
        confirmLabel="Revoke session"
        danger
        onCancel={() => setAuthSessionToRevoke(undefined)}
        onConfirm={() => authSessionToRevoke && void revokeAuthSession(authSessionToRevoke)}
      />
    </>
  );
}
