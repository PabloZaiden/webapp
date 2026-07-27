import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act, useState } from "react";
import { cleanup, fireEvent, render, within } from "@testing-library/react";
import { AnimatedList, Collapsible, StreamingText, TabPanel, TabPanels, Tabs } from "../src/web";

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

beforeEach(ensureHappyDom);

afterEach(() => {
  cleanup();
  document.body.innerHTML = "";
});

afterAll(async () => {
  cleanup();
  if (GlobalRegistrator.isRegistered) {
    await GlobalRegistrator.unregister();
  }
});

async function waitForExit(query: () => Element | null): Promise<void> {
  const deadline = Date.now() + 500;
  while (Date.now() < deadline) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
    if (query() === null) {
      return;
    }
  }
  throw new Error("Timed out waiting for motion exit.");
}

async function waitForText(query: () => string, expected: string): Promise<void> {
  const deadline = Date.now() + 500;
  while (Date.now() < deadline) {
    if (query() === expected) {
      return;
    }
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
  }
  throw new Error(`Timed out waiting for text: ${expected}`);
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
    await waitForExit(() => view.queryByText("Collapsible content"));
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
    await waitForExit(() => view.queryByText("alpha"));
    expect(within(view.container).getByText("beta")).toBeTruthy();
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
    const getStream = () => view.container.querySelector("[data-wapp-streaming-text='active']");

    fireEvent.click(appendFirst);
    expect(getStream()?.querySelectorAll(".wapp-streaming-text-chunk").length).toBe(1);
    fireEvent.click(appendSecond);
    expect(getStream()?.querySelectorAll(".wapp-streaming-text-chunk").length).toBe(1);

    await waitForText(() => getStream()?.textContent ?? "", "Initial first second");
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
    await waitForExit(() => view.queryByText("Overview content"));

    const overviewTab = view.getByRole("tab", { name: "Overview" });
    overviewTab.focus();
    fireEvent.keyDown(overviewTab, { key: "ArrowRight" });
    expect(activityTab.getAttribute("aria-selected")).toBe("true");
    expect(document.activeElement).toBe(activityTab);
  });
});
