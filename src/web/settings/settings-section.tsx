import { useState, type ReactNode } from "react";
import { Button, ConfirmModal, FormSection } from "../components";
import { useAsyncOperation } from "../async-operation";
import type { SettingsAction, SettingsRow, SettingsSection } from "../root-types";

function Action({ action, onError }: { action: SettingsAction; onError: (error?: string) => void }) {
  const [confirming, setConfirming] = useState(false);
  const { pending, start, finish, isCurrent } = useAsyncOperation({ abortOnUnmount: false });
  async function run() {
    const token = start();
    if (!token) return;
    onError(undefined);
    try {
      await action.onAction();
      if (isCurrent(token)) setConfirming(false);
    } catch (error) {
      if (isCurrent(token)) onError(error instanceof Error ? error.message : String(error));
    } finally {
      finish(token);
    }
  }
  return (
    <div className="wapp-settings-action">
      <Button variant={action.variant} tone={action.tone} loading={pending || action.pending} disabled={action.disabled} onClick={() => action.confirmation ? setConfirming(true) : void run()}>
        {action.icon}{action.label}
      </Button>
      {action.disabled && action.disabledReason ? <small>{action.disabledReason}</small> : null}
      {action.confirmation ? <ConfirmModal
        isOpen={confirming}
        onClose={() => { if (!pending) setConfirming(false); }}
        onConfirm={() => void run()}
        loading={pending}
        title={action.confirmation.title}
        message={action.confirmation.message}
        confirmLabel={action.confirmation.confirmLabel ?? action.label}
        variant={action.confirmation.danger ? "danger" : "primary"}
      /> : null}
    </div>
  );
}

export function SettingsFieldRow({ title, description, content, contentPlacement, actions, feedback, danger, labelFor }: Omit<SettingsRow, "id" | "scope">) {
  const [error, setError] = useState<string>();
  const inline = contentPlacement === "inline";
  return (
    <div className={`wapp-settings-field${inline ? " wapp-settings-field-inline" : ""}${danger ? " wapp-settings-field-danger" : ""}`}>
      <div className="wapp-settings-field-label">
        {labelFor ? <label htmlFor={labelFor}>{title}</label> : <strong>{title}</strong>}
        {description ? <p>{description}</p> : null}
      </div>
      {content || actions ? <div className="wapp-settings-field-control">
        {content}
        {actions ? <div className="wapp-row-actions">
          {Array.isArray(actions) ? actions.map((action: SettingsAction) => <Action key={action.id} action={action} onError={setError} />) : actions}
        </div> : null}
      </div> : null}
      {error || feedback ? <div className="wapp-settings-feedback">
        {error ? <p className="wapp-error" role="alert">{error}</p> : null}
        {feedback}
      </div> : null}
    </div>
  );
}

export function SettingsSectionContent({ section }: { section: SettingsSection }) {
  const content: ReactNode = <>
    {section.rows?.map((row) => <SettingsFieldRow key={row.id} {...row} />)}
    {section.render?.()}
  </>;
  if (section.collapsible) {
    return (
      <details className="wapp-settings-disclosure" open={section.defaultExpanded || undefined}>
        <summary>{section.title}</summary>
        {section.actions ? <div className="wapp-row-actions">{section.actions}</div> : null}
        <div className="wapp-settings-disclosure-content">{content}</div>
      </details>
    );
  }
  return <FormSection title={section.title} description={section.description}>
    {section.actions ? <div className="wapp-row-actions">{section.actions}</div> : null}
    {content}
  </FormSection>;
}
