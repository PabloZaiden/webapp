import { useCallback, useEffect, useState } from "react";
import type { WebAppConfigResponse } from "../../contracts";
import { appFetch } from "../api-client";
import { Button, ConfirmDialog, FormSection } from "../components";

const KILL_SERVER_COUNTDOWN_SECONDS = 15;

function computeProgressPercent(countdown: number, total: number): number {
  return total <= 0 ? 0 : (countdown / total) * 100;
}

function useCountdownReload(active: boolean, onComplete: () => void, durationSeconds = KILL_SERVER_COUNTDOWN_SECONDS): { countdown: number; progressPercent: number } {
  const [countdown, setCountdown] = useState(durationSeconds);

  useEffect(() => {
    if (!active) {
      setCountdown(durationSeconds);
      return;
    }

    setCountdown(durationSeconds);
    const interval = window.setInterval(() => {
      setCountdown((previous) => {
        const next = previous - 1;
        if (next <= 0) {
          window.clearInterval(interval);
          onComplete();
          return 0;
        }
        return next;
      });
    }, 1000);

    return () => window.clearInterval(interval);
  }, [active, durationSeconds, onComplete]);

  return {
    countdown,
    progressPercent: computeProgressPercent(countdown, durationSeconds),
  };
}

export function ShutdownSection({ config, setError }: { config: WebAppConfigResponse; setError: (error: string | undefined) => void }) {
  const [confirmKillServer, setConfirmKillServer] = useState(false);
  const [killRequested, setKillRequested] = useState(false);
  const reloadPage = useCallback(() => window.location.reload(), []);
  const { countdown, progressPercent } = useCountdownReload(killRequested, reloadPage);

  async function killServer() {
    try {
      setError(undefined);
      setConfirmKillServer(false);
      await appFetch("/api/server/kill", { method: "POST" });
      setKillRequested(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  if (!config.currentUser?.isAdmin) {
    return null;
  }
  return (
    <>
      <FormSection title="Server operations">
        <div className="wapp-settings-row">
          <div>
            <strong>Kill server</strong>
            <p>Stop the server process. If your deployment restarts it automatically, the app will come back after a moment.</p>
            {killRequested ? (
              <div className="wapp-shutdown-countdown" aria-live="polite">
                <div className="wapp-shutdown-message">Server is shutting down... Reloading in {countdown}s</div>
                <div className="wapp-shutdown-progress" aria-hidden="true">
                  <div className="wapp-shutdown-progress-bar" style={{ width: `${progressPercent}%` }} />
                </div>
              </div>
            ) : null}
          </div>
          <div className="wapp-row-actions">
            <Button type="button" variant="danger" disabled={killRequested} onClick={() => setConfirmKillServer(true)}>Kill server</Button>
          </div>
        </div>
      </FormSection>
      <ConfirmDialog
        open={confirmKillServer}
        title="Kill server?"
        message="Are you sure you want to kill the server?"
        confirmLabel="Kill server"
        danger
        onCancel={() => setConfirmKillServer(false)}
        onConfirm={() => void killServer()}
      />
    </>
  );
}
