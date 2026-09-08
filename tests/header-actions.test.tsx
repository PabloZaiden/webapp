import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, afterEach, expect, test } from "bun:test";
import { useState } from "react";
import {
  HeaderActionsProvider,
  useHeaderActions,
  useHeaderActionsSnapshot,
} from "../src/web/header-actions";

GlobalRegistrator.register();
const { fireEvent, render, screen, waitFor, cleanup } = await import("@testing-library/react");

function HeaderProbe() {
  const { primary, overflow } = useHeaderActionsSnapshot();
  const firstOverflow = overflow[0];
  return (
    <div>
      {primary}
      <button type="button" onClick={firstOverflow?.onAction}>
        {firstOverflow?.label ?? "No overflow"}
      </button>
    </div>
  );
}

function ChildActions({ version }: { version: number }) {
  useHeaderActions({
    primary: <button type="button">Primary {version}</button>,
    overflow: [{
      id: "run",
      label: "Run",
      onAction: () => {
        observedVersion = version;
      },
    }],
  });
  return null;
}

let observedVersion = 0;

function HeaderActionsHarness() {
  const [version, setVersion] = useState(1);
  const [showActions, setShowActions] = useState(true);
  return (
    <HeaderActionsProvider base={{}}>
      <HeaderProbe />
      {showActions ? <ChildActions version={version} /> : null}
      <button type="button" onClick={() => setVersion((current) => current + 1)}>
        Advance
      </button>
      <button type="button" onClick={() => setShowActions(false)}>
        Remove actions
      </button>
    </HeaderActionsProvider>
  );
}

afterEach(() => {
  cleanup();
  observedVersion = 0;
});

afterAll(() => {
  GlobalRegistrator.unregister();
});

test("child views can register primary and overflow actions with live callbacks", async () => {
  render(<HeaderActionsHarness />);

  await waitFor(() => {
    expect(screen.getByRole("button", { name: "Primary 1" })).toBeDefined();
    expect(screen.getByRole("button", { name: "Run" })).toBeDefined();
  });

  fireEvent.click(screen.getByRole("button", { name: "Advance" }));
  await waitFor(() => {
    expect(screen.getByRole("button", { name: "Primary 2" })).toBeDefined();
  });

  fireEvent.click(screen.getByRole("button", { name: "Run" }));
  expect(observedVersion).toBe(2);

  fireEvent.click(screen.getByRole("button", { name: "Remove actions" }));
  await waitFor(() => {
    expect(screen.queryByRole("button", { name: "Primary 2" })).toBeNull();
    expect(screen.getByRole("button", { name: "No overflow" })).toBeDefined();
  });
});
