import type { ActionMenuItem } from "./sidebar/types";

export function isDestructiveActionMenuItem(item: ActionMenuItem): boolean {
  return item.destructive === true || item.id?.toLowerCase().includes("delete") === true || item.label.toLowerCase().includes("delete");
}

export function submitActionMenuForm(item: ActionMenuItem, submitter?: HTMLButtonElement): void {
  if (item.form === undefined) throw new Error("This action does not submit a form.");
  const form = submitter?.form ?? document.getElementById(item.form);
  if (!(form instanceof HTMLFormElement)) throw new Error(`Action form is not mounted: ${item.form}`);
  const button = submitter ?? document.createElement("button");
  if (!submitter) {
    button.type = "submit";
    button.hidden = true;
    button.textContent = item.label;
    if (item.id !== undefined) button.dataset["actionId"] = item.id;
    form.appendChild(button);
  }
  try {
    form.requestSubmit(button);
  } finally {
    if (!submitter) button.remove();
  }
}
