import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act, useRef, useState } from "react";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { AnimatedList, Collapsible, FloatingPanel, StreamingText, TabPanel, TabPanels, Tabs } from "../src/web";
import { installControlledTimers, type ControlledTimers } from "./fixtures/controlled-timers";

let activeTimers: ControlledTimers | undefined;

async function ensureHappyDom() {
  if (
    GlobalRegistrator.isRegistered
    && typeof document !== "undefined"
    && document.body
    && typeof window !== "undefined"
    && typeof window.history?.replaceState === "function"
  ) {
    return;
  }
  if (GlobalRegistrator.isRegistered) {
    await GlobalRegistrator.unregister();
  }
  GlobalRegistrator.register({ url: "http://localhost/" });
}

beforeEach(async () => {
  await ensureHappyDom();
  activeTimers = installControlledTimers();
});

afterEach(() => {
  cleanup();
  activeTimers?.restore();
  activeTimers = undefined;
  document.body.innerHTML = "";
});

afterAll(async () => {
  cleanup();
  if (GlobalRegistrator.isRegistered) {
    await GlobalRegistrator.unregister();
  }
});

function timers(): ControlledTimers {
  if (!activeTimers) {
    throw new Error("Controlled timers were not installed.");
  }
  return activeTimers;
}

describe("framework motion primitives", () => {
  test("keeps collapsible content mounted during exit and removes it after the transition", async () => {
    function Harness() {
      const [open, setOpen] = useState(true);
      return (
        <>
          <button type="button" onClick={() => setOpen((current) => !current)}>Toggle</button>
          <Collapsible open={open} duration={20}>
            <span>Collapsible content</span>
          </Collapsible>
        </>
      );
    }

    const view = render(<Harness />);
    fireEvent.click(view.getByRole("button", { name: "Toggle" }));

    expect(view.getByText("Collapsible content")).toBeTruthy();
    act(() => {
      timers().advanceBy(20);
    });
    expect(view.queryByText("Collapsible content")).toBeNull();
  });

  test("animates anchored floating panels and closes them with Escape", async () => {
    function Harness() {
      const [open, setOpen] = useState(false);
      const anchorRef = useRef<HTMLButtonElement>(null);
      return (
        <>
          <button ref={anchorRef} type="button" onClick={() => setOpen(true)}>Open panel</button>
          <FloatingPanel
            open={open}
            anchorRef={anchorRef}
            onClose={() => setOpen(false)}
          >
            Floating content
          </FloatingPanel>
        </>
      );
    }

    const view = render(<Harness />);
    fireEvent.click(view.getByRole("button", { name: "Open panel" }));

    const panel = view.getByRole("dialog", { name: "Floating panel" });
    expect(panel).toBeTruthy();
    act(() => {
      timers().flushAnimationFrames();
    });
    fireEvent.keyDown(document, { key: "Escape" });
    act(() => {
      timers().advanceBy(350);
    });
    expect(view.queryByRole("dialog", { name: "Floating panel" })).toBeNull();
  });

  test("animates keyed list removals without retaining them indefinitely", async () => {
    function Harness() {
      const [items, setItems] = useState(["alpha", "beta"]);
      return (
        <>
          <button type="button" onClick={() => setItems((current) => current.filter((item) => item !== "alpha"))}>Remove alpha</button>
          <AnimatedList duration={20}>
            {items.map((item) => <div key={item} role="listitem">{item}</div>)}
          </AnimatedList>
        </>
      );
    }

    const view = render(<Harness />);
    fireEvent.click(view.getByRole("button", { name: "Remove alpha" }));

    expect(view.getByText("alpha")).toBeTruthy();
    act(() => {
      timers().advanceBy(20);
    });
    expect(view.queryByText("alpha")).toBeNull();
    expect(view.getByText("beta")).toBeTruthy();
  });

  test("queues streaming appends behind one active chunk and preserves the final text", async () => {
    function Harness() {
      const [content, setContent] = useState("Initial");
      return (
        <>
          <button type="button" onClick={() => setContent((current) => `${current} first`)}>Append first</button>
          <button type="button" onClick={() => setContent((current) => `${current} second`)}>Append second</button>
          <StreamingText as="div" content={content} duration={20} />
        </>
      );
    }

    const view = render(<Harness />);
    const appendFirst = view.getByRole("button", { name: "Append first" });
    const appendSecond = view.getByRole("button", { name: "Append second" });

    fireEvent.click(appendFirst);
    fireEvent.click(appendSecond);

    act(() => {
      timers().advanceBy(20);
    });
    act(() => {
      timers().advanceBy(20);
    });
    expect(view.getByText("Initial first second")).toBeTruthy();
  });

  test("provides accessible tab navigation and transitions tab panels", async () => {
    function Harness() {
      const [active, setActive] = useState("overview");
      return (
        <>
          <Tabs
            value={active}
            onChange={setActive}
            tabs={[
              { id: "overview", label: "Overview" },
              { id: "activity", label: "Activity" },
            ]}
          />
          <TabPanels>
            <TabPanel id="wapp-tab-panel-overview" active={active === "overview"} duration={20}>Overview content</TabPanel>
            <TabPanel id="wapp-tab-panel-activity" active={active === "activity"} duration={20}>Activity content</TabPanel>
          </TabPanels>
        </>
      );
    }

    const view = render(<Harness />);
    const activityTab = view.getByRole("tab", { name: "Activity" });
    expect(activityTab.getAttribute("aria-selected")).toBe("false");
    fireEvent.click(activityTab);

    expect(view.getByText("Activity content")).toBeTruthy();
    act(() => {
      timers().advanceBy(20);
    });
    expect(view.queryByText("Overview content")).toBeNull();

    const overviewTab = view.getByRole("tab", { name: "Overview" });
    overviewTab.focus();
    fireEvent.keyDown(overviewTab, { key: "ArrowRight" });
    expect(activityTab.getAttribute("aria-selected")).toBe("true");
    expect(document.activeElement).toBe(activityTab);
  });
});
