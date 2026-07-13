import { useCallback, useState } from "react";
import type { CreatedUserResponse, WebAppConfigResponse, WebAppUserRole, WebAppUserSummary } from "../../contracts";
import { appJson } from "../api-client";
import { Badge, Button, ConfirmDialog, EmptyState, FormSection, SelectField, TextField } from "../components";
import { useLiveQuery } from "../realtime/useRealtime";
import { ResourceState } from "./resource-state";

export function UserManagement({ config }: { config: WebAppConfigResponse }) {
  const [username, setUsername] = useState("");
  const [role, setRole] = useState<WebAppUserRole>("user");
  const [setupLink, setSetupLink] = useState<string>();
  const [userToDelete, setUserToDelete] = useState<WebAppUserSummary>();
  const [error, setError] = useState<string>();

  const loadUsers = useCallback(
    () => config.userManagement.canManageUsers
      ? appJson<WebAppUserSummary[]>("/api/users")
      : Promise.resolve([]),
    [config.userManagement.canManageUsers],
  );
  const { data: users, error: usersLoadError, loading: usersLoading, refresh: refreshUsers } = useLiveQuery<WebAppUserSummary[]>({ load: loadUsers, realtime: false });

  async function createUser() {
    try {
      setError(undefined);
      const result = await appJson<CreatedUserResponse>("/api/users", { method: "POST", body: JSON.stringify({ username, role }) });
      setUsername("");
      setRole("user");
      setSetupLink(result.setupLink.url);
      await refreshUsers();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function updateRole(user: WebAppUserSummary, nextRole: WebAppUserRole) {
    try {
      setError(undefined);
      await appJson(`/api/users/${encodeURIComponent(user.id)}/role`, { method: "PATCH", body: JSON.stringify({ role: nextRole }) });
      await refreshUsers();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function resetUser(user: WebAppUserSummary) {
    try {
      setError(undefined);
      const result = await appJson<CreatedUserResponse>(`/api/users/${encodeURIComponent(user.id)}/reset`, { method: "POST", body: "{}" });
      setSetupLink(result.setupLink.url);
      await refreshUsers();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function deleteUser(user: WebAppUserSummary) {
    try {
      setError(undefined);
      await appJson(`/api/users/${encodeURIComponent(user.id)}`, { method: "DELETE" });
      setUserToDelete(undefined);
      await refreshUsers();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  if (!config.userManagement.canManageUsers) {
    return null;
  }
  return (
    <FormSection title="User management" description="Create users, reset passkeys, and manage admin access.">
      {error ? <p className="wapp-error">{error}</p> : null}
      <br />
      <div className="wapp-settings-row stacked">
        <div>
          <TextField label="Username" value={username} onChange={(event) => setUsername(event.currentTarget.value)} placeholder="new-user" />
          <br />
          <SelectField label="Role" value={role} onChange={(event) => setRole(event.currentTarget.value as WebAppUserRole)}>
            <option value="user">User</option>
            <option value="admin">Admin</option>
          </SelectField>
        </div>
        <br />
        <div className="wapp-row-actions"><Button type="button" variant="primary" disabled={!username.trim()} onClick={() => void createUser()}>Create setup link</Button></div>
        {setupLink ? <code className="wapp-token">{setupLink}</code> : null}
      </div>
      <br />
      <ResourceState loading={usersLoading} error={usersLoadError} hasData={users !== undefined} refresh={refreshUsers} />
      {users?.length ? (
        <div className="wapp-list">
          {users.map((user) => (
            <div className="wapp-list-row" key={user.id}>
              <span>
                <strong>{user.username}</strong>
                <small>{user.role} · passkey {user.passkeyConfigured ? "configured" : "pending"} · created {user.createdAt}</small>
              </span>
              <div className="wapp-row-actions">
                {user.role !== "owner" ? (
                  <select className="wapp-inline-select" aria-label={`Role for ${user.username}`} value={user.role} onChange={(event) => void updateRole(user, event.currentTarget.value as WebAppUserRole)}>
                    <option value="user">User</option>
                    <option value="admin">Admin</option>
                  </select>
                ) : <Badge variant="success">Owner</Badge>}
                {user.role !== "owner" ? <Button type="button" onClick={() => void resetUser(user)}>Reset</Button> : null}
                <Button type="button" variant="danger" disabled={user.role === "owner"} onClick={() => setUserToDelete(user)}>Delete</Button>
              </div>
            </div>
          ))}
        </div>
      ) : users !== undefined && !usersLoadError ? <EmptyState title="No users" /> : null}
      <ConfirmDialog
        open={Boolean(userToDelete)}
        title="Delete user?"
        message={userToDelete ? `This permanently deletes "${userToDelete.username}" and revokes their setup links, API keys, passkeys and device sessions.` : ""}
        confirmLabel="Delete user"
        danger
        onCancel={() => setUserToDelete(undefined)}
        onConfirm={() => userToDelete && void deleteUser(userToDelete)}
      />
    </FormSection>
  );
}
