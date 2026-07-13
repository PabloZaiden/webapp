import { startAuthentication, startRegistration } from "@simplewebauthn/browser";
import { useCallback, useEffect, useState } from "react";
import type { DeviceVerificationDetails, PasskeyAuthStatusResponse, UserSetupDetails } from "../contracts";
import { appJson } from "./api-client";
import { Badge, Button, Dialog, Panel, TextField } from "./components";

export function PasskeyAuthScreen({ status, refresh }: { status: PasskeyAuthStatusResponse; refresh: () => Promise<void> }) {
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [username, setUsername] = useState("");
  const description = status.bootstrapRequired
    ? "Choose the username for the owner"
    : status.ownerPasskeySetupRequired
      ? "The owner passkey was removed. Set it up again to continue."
      : "Authenticate to continue.";

  async function register(endpoint: "bootstrap" | "owner-setup") {
    setBusy(true);
    setError(undefined);
    try {
      const body = endpoint === "bootstrap" ? JSON.stringify({ username }) : "{}";
      const options = await appJson<PublicKeyCredentialCreationOptionsJSON>(`/api/passkey-auth/${endpoint}/options`, { method: "POST", body });
      const credential = await startRegistration({ optionsJSON: options as never });
      await appJson(`/api/passkey-auth/${endpoint}/verify`, { method: "POST", body: JSON.stringify(credential) });
      await refresh();
      window.location.reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function login() {
    setBusy(true);
    setError(undefined);
    try {
      const options = await appJson<PublicKeyCredentialRequestOptionsJSON>("/api/passkey-auth/authentication/options", { method: "POST", body: "{}" });
      const credential = await startAuthentication({ optionsJSON: options as never });
      await appJson("/api/passkey-auth/authentication/verify", { method: "POST", body: JSON.stringify(credential) });
      await refresh();
      window.location.reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="wapp-auth-screen">
      <Dialog
        className="wapp-auth-dialog"
        title={status.bootstrapRequired ? "Create owner user" : status.ownerPasskeySetupRequired ? "Set up owner passkey" : "Passkey required"}
        actions={status.bootstrapRequired ? (
          <Button type="button" variant="primary" disabled={busy || !username.trim()} onClick={() => void register("bootstrap")}>Create owner</Button>
        ) : status.ownerPasskeySetupRequired ? (
          <Button type="button" variant="primary" disabled={busy} onClick={() => void register("owner-setup")}>Set up owner passkey</Button>
        ) : (
          <Button type="button" variant="primary" disabled={busy} onClick={() => void login()}>Authenticate</Button>
        )}
      >
        <p>{description}</p>
        {error ? <p className="wapp-error">{error}</p> : null}
        {status.bootstrapRequired ? <><br /><TextField label="Username" value={username} onChange={(event) => setUsername(event.currentTarget.value)} placeholder="owner" /></> : null}
      </Dialog>
    </main>
  );
}

export function UserSetupScreen({ refresh }: { refresh: () => Promise<void> }) {
  const token = new URLSearchParams(window.location.search).get("token") ?? "";
  const [details, setDetails] = useState<UserSetupDetails>();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!token) {
      setError("Setup token is missing");
      return;
    }
    void appJson<UserSetupDetails>(`/api/user-setup?token=${encodeURIComponent(token)}`)
      .then(setDetails)
      .catch((err) => setError(err instanceof Error ? err.message : String(err)));
  }, [token]);

  async function setup() {
    setBusy(true);
    setError(undefined);
    try {
      const options = await appJson<PublicKeyCredentialCreationOptionsJSON>("/api/user-setup/options", { method: "POST", body: JSON.stringify({ token }) });
      const credential = await startRegistration({ optionsJSON: options as never });
      await appJson("/api/user-setup/verify", { method: "POST", body: JSON.stringify({ token, response: credential }) });
      window.history.replaceState(null, "", "/");
      await refresh();
      window.location.reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="wapp-auth-screen">
      <Dialog
        className="wapp-auth-dialog"
        title={details?.kind === "reset" ? "Reset passkey" : "Finish user setup"}
        actions={<Button type="button" variant="primary" disabled={busy || !details} onClick={() => void setup()}>Set up passkey</Button>}
      >
        <p>{details ? `Username: ${details.username}` : "Loading setup link..."}</p>
        {details ? <p className="wapp-muted">Role: {details.role}. This link expires at {details.expiresAt}.</p> : null}
        {error ? <p className="wapp-error">{error}</p> : null}
      </Dialog>
    </main>
  );
}

export function DeviceVerificationScreen() {
  const params = new URLSearchParams(window.location.search);
  const initialCode = params.get("user_code") ?? "";
  const [userCode, setUserCode] = useState(initialCode);
  const [details, setDetails] = useState<DeviceVerificationDetails>();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    if (!userCode.trim()) {
      setDetails(undefined);
      return;
    }
    setBusy(true);
    setError(undefined);
    try {
      setDetails(await appJson<DeviceVerificationDetails>(`/api/auth/device/verification?user_code=${encodeURIComponent(userCode.trim())}`));
    } catch (err) {
      setDetails(undefined);
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }, [userCode]);

  useEffect(() => void load(), [load]);

  async function decide(action: "approve" | "deny") {
    if (!details) {
      return;
    }
    setBusy(true);
    setError(undefined);
    try {
      setDetails(await appJson<DeviceVerificationDetails>(`/api/auth/device/${action}`, {
        method: "POST",
        body: JSON.stringify({ user_code: details.userCode }),
      }));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="wapp-device-screen">
      <Panel title="Authorize device" description="Enter the code shown by the CLI or external device.">
        <div className="wapp-device-stack">
          <TextField label="User code" value={userCode} onChange={(event) => setUserCode(event.currentTarget.value.toUpperCase())} placeholder="ABCD-2345" />
          {error ? <p className="wapp-error">{error}</p> : null}
          {details ? (
            <div className="wapp-device-card">
              <div><strong>Client</strong><span>{details.clientId}</span></div>
              <div><strong>Scope</strong><span>{details.scope}</span></div>
              <div><strong>Status</strong><Badge variant={details.status === "approved" ? "success" : details.status === "denied" ? "error" : details.status === "consumed" ? "disabled" : "warning"}>{details.status}</Badge></div>
              <div><strong>Expires</strong><span>{details.expiresAt}</span></div>
            </div>
          ) : null}
          <div className="wapp-row-actions">
            <Button type="button" variant="ghost" disabled={busy || !details || details.status !== "pending"} onClick={() => void decide("deny")}>Deny</Button>
            <Button type="button" variant="primary" disabled={busy || !details || details.status !== "pending"} onClick={() => void decide("approve")}>Approve</Button>
          </div>
        </div>
      </Panel>
    </main>
  );
}
