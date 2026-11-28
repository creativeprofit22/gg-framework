import { describe, expect, it } from "vitest";
import { FakeClock, FakeControlClient, pageState } from "../test-support/dev-app-driver-fakes.js";
import { createDevAppDriver, DevAppActionError, type ActionOutcome } from "./driver.js";
import { condition, elementAppears, focusOn, pageChanged, promptStarted } from "./expectations.js";
import { parseSnapshot, refLocatorScript, snapshotScript } from "./snapshot.js";
import {
  appShellHtml,
  createFixturePage,
  DomControlClient,
  fieldValue,
} from "../test-support/dev-app-dom.js";
import { observeScript, parsePageState } from "./observe.js";
import { parseHTML } from "linkedom";

function setup() {
  const clock = new FakeClock();
  const client = new FakeControlClient();
  const driver = createDevAppDriver({ client, clock });
  // Typing lands in the composer straight away, as Input.insertText does in the app.
  client.onInput = ({ method, params }) => {
    if (method === "Input.insertText") client.page.draft += String(params.text);
  };
  return { clock, client, driver };
}

async function failure(promise: Promise<unknown>): Promise<ActionOutcome> {
  const error = await promise.then(
    () => null,
    (caught: unknown) => caught,
  );
  expect(error).toBeInstanceOf(DevAppActionError);
  return (error as DevAppActionError).outcome;
}

const enters = (client: FakeControlClient) =>
  client
    .inputs("Input.dispatchKeyEvent")
    .filter(({ params }) => params.key === "Enter" && params.type === "keyDown");

describe("dev app driver: send prompt", () => {
  it("confirms once the composer clears and the pane shows Working", async () => {
    const { clock, client, driver } = setup();
    client.onInput = ({ method, params }) => {
      if (method === "Input.insertText") client.page.draft += String(params.text);
      if (params.key === "Enter" && params.type === "keyDown") {
        clock.at(clock.now() + 200, () => {
          client.page = pageState({ draft: "", status: "Working" });
        });
      }
    };
    const outcome = await clock.settle(driver.sendPrompt("scene:stream"));
    expect(outcome.verdict).toBe("confirmed");
    expect(outcome.changed).toBe(true);
    expect(outcome.observed?.page.status).toBe("Working");
    expect(outcome.elapsedMs).toBeGreaterThanOrEqual(200);
    expect(outcome.elapsedMs).toBeLessThan(400);
    expect(client.inputs("Input.insertText")[0]?.params.text).toBe("scene:stream");
    expect(enters(client)[0]?.params.text).toBe("\r");
  });

  it("fails before pressing Enter when a menu is open, long before the deadline", async () => {
    const { clock, client, driver } = setup();
    client.onInput = ({ method, params }) => {
      if (method === "Input.insertText") {
        client.page.draft += String(params.text);
        client.page.menuOpen = true;
      }
    };
    const outcome = await failure(clock.settle(driver.sendPrompt("/com")));
    expect(outcome.verdict).toBe("contradicted");
    expect(outcome.reason).toMatch(/menu is open .*"\/com"/);
    expect(outcome.elapsedMs).toBeLessThan(100);
    expect(outcome.baseline?.page.menuOpen).toBe(true);
    expect(enters(client)).toHaveLength(0);
  });

  it("reads an open menu from the composer's data attribute when no .slash-menu is in the pane", async () => {
    const { document } = parseHTML(
      '<div data-pane-id="p1"><div class="agent-pane"><textarea class="input" data-slash-menu-open="true">/com</textarea></div></div>',
    );
    const read = new Function("document", `return ${observeScript()}`) as (doc: unknown) => unknown;
    const page = parsePageState(read(document));
    expect(page?.menuOpen).toBe(true);

    const { clock, client, driver } = setup();
    client.onInput = ({ method }) => {
      if (method === "Input.insertText" && page) client.page = { ...page, draft: "/com" };
    };
    const outcome = await failure(clock.settle(driver.sendPrompt("/com")));
    expect(outcome.verdict).toBe("contradicted");
    expect(outcome.reason).toMatch(/a menu is open/);
    expect(enters(client)).toHaveLength(0);
  });

  it("fails on the first read after Enter when Enter opens a menu instead of sending", async () => {
    const { clock, client, driver } = setup();
    client.onInput = ({ method, params }) => {
      if (method === "Input.insertText") client.page.draft += String(params.text);
      if (params.key === "Enter" && params.type === "keyDown") client.page.menuOpen = true;
    };
    const outcome = await failure(clock.settle(driver.sendPrompt("/com")));
    expect(outcome.verdict).toBe("contradicted");
    expect(outcome.reason).toMatch(/menu is open/);
    expect(outcome.elapsedMs).toBe(0);
    expect(enters(client)).toHaveLength(1);
  });

  it("reports an unchanged draft at the deadline", async () => {
    const { clock, client, driver } = setup();
    const outcome = await failure(clock.settle(driver.sendPrompt("hello")));
    expect(outcome.verdict).toBe("contradicted");
    expect(outcome.reason).toMatch(/not met within 5000 ms; draft is unchanged \("hello"\)/);
    expect(outcome.changed).toBe(false);
    expect(outcome.elapsedMs).toBe(5000);
    expect(enters(client)).toHaveLength(1);
  });

  it("does not count slash completion of the draft as sending it", async () => {
    const { clock, client, driver } = setup();
    client.onInput = ({ method, params }) => {
      if (method === "Input.insertText") client.page.draft += String(params.text);
      if (params.key === "Enter" && params.type === "keyDown") client.page.draft = "/commit ";
    };
    const outcome = await failure(clock.settle(driver.sendPrompt("/com")));
    expect(outcome.verdict).toBe("contradicted");
    expect(outcome.changed).toBe(true);
    expect(outcome.reason).toMatch(/draft changed to "\/commit " but was not sent/);
  });

  it("refuses to send when the pane is already Working, since it would only queue", async () => {
    const { clock, client, driver } = setup();
    client.page.status = "Working";
    // The typing step passes; the send step sees the busy pane before pressing Enter.
    const outcome = await failure(clock.settle(driver.sendPrompt("next")));
    expect(outcome.verdict).toBe("contradicted");
    expect(outcome.reason).toMatch(/already Working.*nothing was sent/);
    expect(enters(client)).toHaveLength(0);
  });

  it("fails when Enter queues the prompt instead of starting it", async () => {
    const { clock, client, driver } = setup();
    client.onInput = ({ method, params }) => {
      if (method === "Input.insertText") client.page.draft += String(params.text);
      if (params.key === "Enter" && params.type === "keyDown") {
        client.page.draft = "";
        client.page.queued = 1;
      }
    };
    const outcome = await failure(clock.settle(driver.sendPrompt("later")));
    expect(outcome.verdict).toBe("contradicted");
    expect(outcome.reason).toMatch(/queued instead of starting/);
  });

  it("is unreadable straight away when the target goes mid-wait", async () => {
    const { clock, client, driver } = setup();
    client.onInput = ({ method, params }) => {
      if (method === "Input.insertText") client.page.draft += String(params.text);
      if (params.key === "Enter" && params.type === "keyDown") {
        clock.at(clock.now() + 300, () => client.gone());
      }
    };
    const outcome = await failure(clock.settle(driver.sendPrompt("hello")));
    expect(outcome.verdict).toBe("unreadable");
    expect(outcome.reason).toMatch(/target gone: dev fixture debugging target detached/);
    expect(outcome.elapsedMs).toBeLessThan(500);
  });

  it("treats a pane that disappears as target gone, not as a pending state", async () => {
    const { clock, client, driver } = setup();
    client.onInput = ({ method, params }) => {
      if (method === "Input.insertText") client.page.draft += String(params.text);
      if (params.key === "Enter" && params.type === "keyDown") {
        client.page = pageState({ paneFound: false, draft: null, status: null });
      }
    };
    const outcome = await failure(clock.settle(driver.sendPrompt("hello")));
    expect(outcome.verdict).toBe("unreadable");
    expect(outcome.reason).toMatch(/pane is not on the page/);
    expect(outcome.elapsedMs).toBeLessThan(100);
  });
});

describe("dev app driver: checked actions", () => {
  it("is unreadable and sends nothing when the starting state cannot be read", async () => {
    const { clock, client, driver } = setup();
    client.readOverride = () => Promise.reject(new Error("Dev fixture evaluation failed: boom"));
    const outcome = await failure(clock.settle(driver.press("Tab", { expect: focusOn("button") })));
    expect(outcome.verdict).toBe("unreadable");
    expect(outcome.reason).toMatch(/could not read the starting state .*boom.*nothing was sent/);
    expect(client.sent).toHaveLength(0);
  });

  it("is unreadable when a later read throws, never confirmed", async () => {
    const { clock, client, driver } = setup();
    client.readOverride = (count) =>
      count > 1 ? Promise.reject(new Error("Dev fixture evaluation failed: boom")) : undefined;
    const outcome = await failure(clock.settle(driver.press("Tab", { expect: focusOn("button") })));
    expect(outcome.verdict).toBe("unreadable");
    expect(outcome.reason).toMatch(/page read failed/);
  });

  it("bounds a read that never answers by the action deadline", async () => {
    const { clock, client, driver } = setup();
    client.readOverride = (count) => (count > 1 ? new Promise(() => {}) : undefined);
    const outcome = await failure(
      clock.settle(driver.press("Tab", { expect: focusOn("button"), deadlineMs: 800 })),
    );
    expect(outcome.verdict).toBe("unreadable");
    expect(outcome.reason).toMatch(/did not answer before the deadline; no state was read/);
    expect(outcome.elapsedMs).toBe(800);
  });

  it("times out at the deadline and says the page changed without meeting the condition", async () => {
    const { clock, client, driver } = setup();
    client.probe = false;
    client.onInput = () => {
      client.page.focused = { tag: "button", paneId: "pane-a", label: "Close" };
    };
    const outcome = await failure(
      clock.settle(driver.press("Tab", { expect: elementAppears(".menu"), deadlineMs: 1000 })),
    );
    expect(outcome.verdict).toBe("contradicted");
    expect(outcome.changed).toBe(true);
    expect(outcome.reason).toMatch(/not met within 1000 ms; the page changed/);
    expect(outcome.elapsedMs).toBe(1000);
    expect(outcome.observed?.page.focused?.label).toBe("Close");
  });

  it("refuses to act when the expected result already holds", async () => {
    const { clock, client, driver } = setup();
    client.probe = true;
    const outcome = await failure(
      clock.settle(driver.press("Escape", { expect: elementAppears(".pane") })),
    );
    expect(outcome.verdict).toBe("contradicted");
    expect(outcome.reason).toMatch(/already true before acting; nothing was sent/);
    expect(client.sent).toHaveLength(0);
  });

  it("confirms a press whose condition becomes true after acting", async () => {
    const { clock, client, driver } = setup();
    client.probe = false;
    client.onInput = ({ params }) => {
      if (params.type === "keyUp") clock.at(clock.now() + 120, () => (client.probe = true));
    };
    const outcome = await clock.settle(
      driver.press("ArrowRight", { modifiers: ["ctrl", "alt"], expect: focusOn("[data-b]") }),
    );
    expect(outcome.verdict).toBe("confirmed");
    expect(client.inputs("Input.dispatchKeyEvent")[0]?.params.modifiers).toBe(3);
  });

  it("allows a no-change check when requireChange is false", async () => {
    const { clock, client, driver } = setup();
    client.probe = true;
    const outcome = await clock.settle(
      driver.pointerUp(
        { x: 10, y: 20 },
        { expect: condition("pane did not move", "true", { requireChange: false }) },
      ),
    );
    expect(outcome.verdict).toBe("confirmed");
    expect(client.inputs("Input.dispatchMouseEvent")).toHaveLength(1);
  });

  it("still fails a no-change action when acting breaks the condition", async () => {
    const { clock, client, driver } = setup();
    client.probe = true;
    client.onInput = () => {
      client.probe = false;
    };
    const outcome = await failure(
      clock.settle(
        driver.pointerDown(
          { x: 10, y: 20 },
          {
            expect: condition("target stayed put", "true", { requireChange: false }),
            deadlineMs: 300,
          },
        ),
      ),
    );
    expect(outcome.verdict).toBe("contradicted");
    expect(outcome.reason).toMatch(/not met within 300 ms/);
    expect(client.inputs("Input.dispatchMouseEvent")).toHaveLength(2);
  });

  it("rejects infinite, zero and non-number deadlines before doing anything", async () => {
    const { client, driver } = setup();
    for (const deadlineMs of [Number.POSITIVE_INFINITY, 0, -1, Number.NaN]) {
      await expect(driver.press("Tab", { expect: focusOn("button"), deadlineMs })).rejects.toThrow(
        RangeError,
      );
    }
    expect(() => createDevAppDriver({ client, deadlineMs: Number.POSITIVE_INFINITY })).toThrow(
      RangeError,
    );
    expect(client.reads).toBe(0);
  });

  it("does not click an element that something else covers", async () => {
    const { clock, client, driver } = setup();
    client.probe = false;
    client.onScript = (script) =>
      script.includes("elementFromPoint") ? { problem: 'covered by div "overlay"' } : undefined;
    const outcome = await failure(
      clock.settle(driver.click("button.send", { expect: elementAppears(".done") })),
    );
    expect(outcome.verdict).toBe("contradicted");
    expect(outcome.reason).toMatch(/covered by div "overlay"; nothing was sent/);
    expect(client.inputs("Input.dispatchMouseEvent")).toHaveLength(0);
  });

  it("clicks the measured centre of an uncovered element", async () => {
    const { clock, client, driver } = setup();
    client.probe = false;
    client.onScript = (script) =>
      script.includes("elementFromPoint") ? { x: 50, y: 60 } : undefined;
    client.onInput = ({ params }) => {
      if (params.type === "mouseReleased") client.probe = true;
    };
    const outcome = await clock.settle(
      driver.click("button.send", { expect: elementAppears(".done") }),
    );
    expect(outcome.verdict).toBe("confirmed");
    expect(client.inputs("Input.dispatchMouseEvent").map(({ params }) => params.type)).toEqual([
      "mouseMoved",
      "mousePressed",
      "mouseReleased",
    ]);
    expect(client.inputs("Input.dispatchMouseEvent")[1]?.params).toMatchObject({ x: 50, y: 60 });
  });
});

describe("dev app driver: waitFor and observe", () => {
  it("confirms a condition that already holds without needing a change", async () => {
    const { clock, client, driver } = setup();
    client.probe = true;
    const outcome = await clock.settle(driver.waitFor("app shell", elementAppears(".app")));
    expect(outcome.verdict).toBe("confirmed");
    expect(client.sent).toHaveLength(0);
  });

  it("still ends at the deadline when the condition never holds", async () => {
    const { clock, client, driver } = setup();
    client.probe = false;
    const outcome = await failure(
      clock.settle(driver.waitFor("app shell", elementAppears(".app"), { deadlineMs: 300 })),
    );
    expect(outcome.verdict).toBe("contradicted");
    expect(outcome.reason).toMatch(/not met within 300 ms; nothing changed/);
    expect(outcome.elapsedMs).toBe(300);
  });

  it("observe returns the parsed page state and rejects malformed answers", async () => {
    const { clock, client, driver } = setup();
    client.page.draft = "draft";
    expect((await clock.settle(driver.observe())).draft).toBe("draft");
    client.readOverride = () => Promise.resolve({ page: { paneFound: "yes" }, probe: null });
    await expect(clock.settle(driver.observe())).rejects.toThrow(/unexpected shape/);
  });

  it("promptStarted reports an error message with what it saw", async () => {
    const { clock, client, driver } = setup();
    client.page.draft = "";
    const error = await clock
      .settle(driver.press("Enter", { expect: promptStarted(), deadlineMs: 100 }))
      .then(
        () => null,
        (caught: unknown) => caught,
      );
    expect(error).toBeInstanceOf(DevAppActionError);
    expect((error as Error).message).toMatch(
      /^press Enter contradicted .*saw draft "", menu closed, status Ready, focus textarea$/,
    );
  });
});

describe("dev app driver: a prompt whose run fails at once", () => {
  it("says the prompt was sent but the run failed, without waiting for the deadline", async () => {
    const { clock, client, driver } = setup();
    client.onInput = () => {
      client.page.draft = "";
      client.page.status = "Error";
    };
    const error = await clock
      .settle(driver.press("Enter", { expect: promptStarted(), deadlineMs: 5000 }))
      .then(
        () => null,
        (caught: unknown) => caught,
      );
    expect(error).toBeInstanceOf(DevAppActionError);
    expect((error as Error).message).toMatch(/the prompt left the composer but the run failed/);
    expect(clock.time).toBeLessThan(5000);
  });
});

describe("dev app driver: acting on snapshot refs", () => {
  const CONTROLS = `
    <button class="go" data-rect="10,10,80,20">Go</button>
    <button class="off" disabled data-rect="10,40,80,20">Off</button>
    <button class="soft" aria-disabled="true" data-rect="10,70,80,20">Soft</button>
    <button class="under" data-rect="300,10,80,20">Under</button>
    <div class="toast" data-z="5" aria-label="Saved" data-rect="290,0,120,40"></div>
    <input class="name" aria-label="Name" data-rect="10,100,200,20">`;

  function domSetup() {
    const clock = new FakeClock();
    const page = createFixturePage(appShellHtml({ pane: CONTROLS }));
    const client = new DomControlClient(page);
    const driver = createDevAppDriver({ client, clock });
    const refs = (): Map<string, string> => {
      const parsed = parseSnapshot(page.evaluate(snapshotScript()));
      if (typeof parsed === "string") throw new Error(parsed);
      return new Map(parsed.elements.map((element) => [element.name, element.ref ?? ""]));
    };
    const locator = (name: string, generation = 1) =>
      refLocatorScript(refs().get(name) ?? "", generation);
    return { clock, page, client, driver, refs, locator };
  }

  it("clicks the element behind a ref and confirms the inferred page change", async () => {
    const { clock, page, client, driver, locator } = domSetup();
    client.onClick = (element) => {
      if (element.matches(".go")) page.find(".go").setAttribute("aria-expanded", "true");
    };
    const outcome = await clock.settle(
      driver.clickElement("click e1", locator("Go"), { expect: pageChanged() }),
    );
    expect(outcome.verdict).toBe("confirmed");
    expect(outcome.blockedBy).toBeUndefined();
    expect(client.inputs("Input.dispatchMouseEvent")[2]?.params).toMatchObject({ x: 50, y: 20 });
  });

  it.each([
    ["Off", "disabled"],
    ["Soft", "disabled"],
    ["Under", "covered"],
  ])("refuses to click %s (%s) and sends nothing", async (name, block) => {
    const { clock, client, driver, locator } = domSetup();
    const outcome = await failure(
      clock.settle(driver.clickElement(`click ${name}`, locator(name), { expect: pageChanged() })),
    );
    expect(outcome.verdict).toBe("contradicted");
    expect(outcome.blockedBy).toBe(block);
    expect(outcome.reason).toMatch(/nothing was sent$/);
    expect(client.inputs("Input.dispatchMouseEvent")).toHaveLength(0);
  });

  it("names what covers an element", async () => {
    const { clock, driver, locator } = domSetup();
    const outcome = await failure(
      clock.settle(driver.clickElement("click Under", locator("Under"), { expect: pageChanged() })),
    );
    expect(outcome.reason).toMatch(/covered by div "Saved"/);
  });

  it("refuses a ref from an older snapshot as stale", async () => {
    const { clock, client, driver, refs } = domSetup();
    const goRef = refs().get("Go") ?? "";
    refs();
    const outcome = await failure(
      clock.settle(
        driver.clickElement("click", refLocatorScript(goRef, 1), { expect: pageChanged() }),
      ),
    );
    expect(outcome.blockedBy).toBe("stale");
    expect(outcome.reason).toMatch(/older snapshot/);
    expect(client.sent).toHaveLength(0);
  });

  it("types into the element behind a ref after focusing it", async () => {
    const { clock, page, driver, locator } = domSetup();
    const outcome = await clock.settle(
      driver.type("hello", { intoElement: locator("Name"), expect: pageChanged() }),
    );
    expect(outcome.verdict).toBe("confirmed");
    expect(fieldValue(page.find(".name"))).toBe("hello");
    expect(page.document.activeElement).toBe(page.find(".name"));
  });

  it("refuses to type into a disabled element", async () => {
    const { clock, client, driver, locator } = domSetup();
    const outcome = await failure(
      clock.settle(driver.type("x", { intoElement: locator("Off"), expect: pageChanged() })),
    );
    expect(outcome.blockedBy).toBe("disabled");
    expect(client.inputs("Input.insertText")).toHaveLength(0);
  });

  it("pageChanged times out when nothing visible changes", async () => {
    const { clock, driver } = domSetup();
    const outcome = await failure(
      clock.settle(driver.press("Tab", { expect: pageChanged(), deadlineMs: 200 })),
    );
    expect(outcome.verdict).toBe("contradicted");
    expect(outcome.expectation).toBe("the page changed");
    expect(outcome.reason).toMatch(/nothing changed/);
  });

  it("selector clicks still refuse a disabled button", async () => {
    const { clock, client, driver } = domSetup();
    const outcome = await failure(
      clock.settle(driver.click("button.off", { expect: pageChanged() })),
    );
    expect(outcome.blockedBy).toBe("disabled");
    expect(client.inputs("Input.dispatchMouseEvent")).toHaveLength(0);
  });
});
