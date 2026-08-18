// @vitest-environment happy-dom
// ═══════════════════════════════════════════════════════════════════════════
// <ChartInspector> — the page that builds itself, rendered for real.
//
// Same harness as `src/react/react.test.tsx`: a real `react-dom/client` root
// under happy-dom, driven with `act`. No renderer mocks — the component owns a
// live runtime, and the claim under test is precisely that a live runtime plus
// a chart is enough to produce the whole debugger.
//
// The assertions are about DERIVATION, not appearance. Nothing below tells the
// component a message name, a state name, or which control should be disabled;
// every one of those is read out of the DOM and checked against `lane`.
// ═══════════════════════════════════════════════════════════════════════════
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { SubId } from "../../pure/core";
import { assign, guards, lane } from "../__fixtures__/lane";
import {
  fetchReducerBoot,
  fetchReducerChart,
  assign as rAssign,
  cells as rCells,
} from "../__fixtures__/resilient-fetch-reducer";
import type { Samples } from "./index";
import { ChartInspector, ReducerChartInspector } from "./react";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const samples: Samples<typeof lane> = {
  WIP: { at: 1 },
  DONE: { at: 2 },
  BLOCKED: { at: 3, reason: "review backed up" },
  PASS: { at: 4 },
  FAIL: { at: 5, reason: "flaky" },
  UNBLOCKED: { at: 6 },
};

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => {
    root.unmount();
  });
  container.remove();
});

async function mount(): Promise<void> {
  await act(async () => {
    root.render(
      <ChartInspector
        chart={lane}
        parts={{ assign, guards }}
        boot={() => ({ retries: 0, maxRetries: 3 })}
        samples={samples}
        title="lane"
      />,
    );
  });
  // one more flush for the `ready` capture that swaps "booting…" for the view
  await act(async () => {});
}

/** Every event control on screen, keyed by the event it names. */
function controls(): Map<string, HTMLElement> {
  const out = new Map<string, HTMLElement>();
  for (const el of container.querySelectorAll<HTMLElement>("[data-event]")) {
    out.set(el.dataset.event as string, el);
  }
  return out;
}

const statusOf = (e: string): string =>
  controls().get(e)?.dataset.status ?? "missing";
const buttonFor = (e: string): HTMLButtonElement =>
  controls().get(e)?.querySelector("button") as HTMLButtonElement;
const currentState = (): string =>
  container.querySelector(".tea-ci-state")?.textContent ?? "";

async function click(el: HTMLElement): Promise<void> {
  await act(async () => {
    el.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
  await act(async () => {});
}

describe("<ChartInspector> — the button row is derived, not configured", () => {
  it("renders one control per DECLARED event, in chart order", async () => {
    await mount();
    expect([...controls().keys()]).toEqual([
      "WIP",
      "DONE",
      "BLOCKED",
      "PASS",
      "FAIL",
      "UNBLOCKED",
    ]);
  });

  it("boots at the state the chart marks `initial: true`", async () => {
    await mount();
    expect(currentState()).toBe("queued");
    expect(container.querySelector(".tea-ci-phase")?.textContent).toBe(
      "working",
    );
  });

  it("draws a refused event as REFUSED, with the reason — never as absent", async () => {
    await mount();
    // At `queued`: WIP and BLOCKED are routed; the rest are refused, and each
    // refusal carries the sentence that says which mechanism refused it.
    expect(statusOf("WIP")).toBe("legal");
    expect(statusOf("BLOCKED")).toBe("legal");
    for (const e of ["DONE", "PASS", "FAIL"]) {
      expect(statusOf(e)).toBe("refused");
      // the reason names the pair that is missing — no phase, no scope jargon
      expect(controls().get(e)?.textContent).toContain(
        `"queued" declares no "${e}" edge`,
      );
      expect(buttonFor(e).disabled).toBe(true);
    }
    // UNBLOCKED is scoped to `parked` — refused here for the same reason, and
    // the control is still on screen.
    expect(statusOf("UNBLOCKED")).toBe("refused");
  });

  it("shows where a legal event would land, and what it would fire", async () => {
    await mount();
    expect(controls().get("WIP")?.textContent).toContain("→ build");
  });
});

describe("<ChartInspector> — dispatching moves the whole page", () => {
  it("a click transitions the machine and re-derives every control", async () => {
    await mount();
    await click(buttonFor("WIP"));
    expect(currentState()).toBe("build");
    // at `build`, DONE is now routed and WIP is not
    expect(statusOf("DONE")).toBe("legal");
    expect(statusOf("WIP")).toBe("refused");
  });

  it("an out-of-phase event flips to refused when the phase changes", async () => {
    await mount();
    await click(buttonFor("BLOCKED"));
    expect(currentState()).toBe("blocked");
    // `parked` now: BLOCKED is scoped to `working`, UNBLOCKED to `parked`.
    expect(statusOf("BLOCKED")).toBe("refused");
    expect(statusOf("UNBLOCKED")).toBe("legal");
    // and the resume edge resolves off the injected `was`
    expect(controls().get("UNBLOCKED")?.textContent).toContain("→ queued");
  });

  it("an end state refuses everything, and says so on every control", async () => {
    await mount();
    for (const e of ["WIP", "DONE", "PASS", "DONE"]) {
      await click(buttonFor(e));
    }
    expect(currentState()).toBe("shipped");
    for (const [, el] of controls()) {
      expect(el.dataset.status).toBe("refused");
      expect(el.textContent).toContain("end state");
    }
  });

  it("logs every dispatched msg", async () => {
    await mount();
    await click(buttonFor("WIP"));
    await click(buttonFor("DONE"));
    const log = container.querySelector(".tea-dt-log")?.textContent ?? "";
    expect(log).toContain("WIP");
    expect(log).toContain("DONE");
  });
});

describe("<ChartInspector> — the guard preview, on screen", () => {
  it("shows which branch the guard would take right now", async () => {
    await mount();
    await click(buttonFor("WIP"));
    await click(buttonFor("DONE"));
    expect(currentState()).toBe("review");
    // retries 0 < maxRetries 3 and reason is not "fatal" → the guard HOLDS
    expect(controls().get("FAIL")?.textContent).toContain(
      "→ build [retriesRemaining]",
    );
  });

  it("the branch flips when the operator edits the sample payload", async () => {
    await mount();
    await click(buttonFor("WIP"));
    await click(buttonFor("DONE"));
    const box = controls()
      .get("FAIL")
      ?.querySelector("textarea") as HTMLTextAreaElement;
    expect(box).toBeTruthy();
    await act(async () => {
      // `retriesRemaining` reads `m.reason !== "fatal"` — so this alone must
      // move the previewed branch from `then` to `else`.
      const setter = Object.getOwnPropertyDescriptor(
        HTMLTextAreaElement.prototype,
        "value",
      )?.set;
      setter?.call(box, '{"at":5,"reason":"fatal"}');
      box.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(controls().get("FAIL")?.textContent).toContain(
      "→ frozen [!retriesRemaining]",
    );
  });

  it("an unparseable payload degrades to `no sample`, not to a stale guess", async () => {
    await mount();
    const box = controls()
      .get("WIP")
      ?.querySelector("textarea") as HTMLTextAreaElement;
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(
        HTMLTextAreaElement.prototype,
        "value",
      )?.set;
      setter?.call(box, "{not json");
      box.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(controls().get("WIP")?.textContent).toContain("no sample");
    expect(buttonFor("WIP").disabled).toBe(true);
  });
});

describe("<ChartInspector> — time travel is pure replay of a prefix", () => {
  it("scrubbing back shows the state at that step", async () => {
    await mount();
    await click(buttonFor("WIP"));
    await click(buttonFor("DONE"));
    expect(currentState()).toBe("review");

    const range = container.querySelector(
      'input[type="range"]',
    ) as HTMLInputElement;
    expect(range.max).toBe("2");

    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        "value",
      )?.set;
      setter?.call(range, "1");
      range.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(currentState()).toBe("build");

    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        "value",
      )?.set;
      setter?.call(range, "0");
      range.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(currentState()).toBe("queued");
  });

  it("scrubbing does not rewind the RUNTIME — `live` returns to the present", async () => {
    await mount();
    await click(buttonFor("WIP"));
    const range = container.querySelector(
      'input[type="range"]',
    ) as HTMLInputElement;
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        "value",
      )?.set;
      setter?.call(range, "0");
      range.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(currentState()).toBe("queued");
    // every control is inert while scrubbed — a dispatch from the past would
    // append to the present, which is a lie about what you clicked.
    expect(buttonFor("WIP").disabled).toBe(true);

    const live = [...container.querySelectorAll("button")].find(
      (b) => b.textContent === "live",
    ) as HTMLButtonElement;
    await click(live);
    expect(currentState()).toBe("build");
    expect(buttonFor("DONE").disabled).toBe(false);
  });

  it("reset re-boots the machine and clears the tape", async () => {
    await mount();
    await click(buttonFor("WIP"));
    await click(buttonFor("DONE"));
    const reset = [...container.querySelectorAll("button")].find(
      (b) => b.textContent === "reset",
    ) as HTMLButtonElement;
    await click(reset);
    expect(currentState()).toBe("queued");
    const range = container.querySelector(
      'input[type="range"]',
    ) as HTMLInputElement;
    expect(range.max).toBe("0");
  });
});

describe("<ChartInspector> — the diagram", () => {
  it("draws the chart with phases, and lights the current node", async () => {
    await mount();
    const pre = container.querySelector(".tea-ci-mermaid")?.textContent ?? "";
    expect(pre).toContain("state working {");
    expect(pre).toContain("state parked {");
    expect(pre).toContain("class queued teaActive");
    await click(buttonFor("WIP"));
    const after = container.querySelector(".tea-ci-mermaid")?.textContent ?? "";
    expect(after).toContain("class build teaActive");
    expect(after).not.toContain("class queued teaActive");
  });

  it("gives the mermaid host a NEW node every time the drawing changes", async () => {
    await mount();
    // Every mermaid host marks what it has rendered (`data-processed`) and
    // skips those nodes forever, so React updating in place — which rewrites
    // only the TEXT — leaves the reader looking at mermaid source from the
    // second frame on. A key derived from the content forces an unmount, and a
    // `key` has no DOM projection, so node IDENTITY is the only thing that can
    // tell the two worlds apart. The lane shipped this bug once already.
    const node = () => container.querySelector(".tea-ci-mermaid");
    const first = node();
    expect(first?.textContent).toContain("class queued teaActive");
    await click(buttonFor("WIP"));
    expect(node()?.textContent).toContain("class build teaActive");
    expect(node()).not.toBe(first);
  });

  it("the highlight follows the SCRUBBED state, not only the live one", async () => {
    await mount();
    await click(buttonFor("WIP"));
    const range = container.querySelector(
      'input[type="range"]',
    ) as HTMLInputElement;
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        "value",
      )?.set;
      setter?.call(range, "0");
      range.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(container.querySelector(".tea-ci-mermaid")?.textContent).toContain(
      "class queued teaActive",
    );
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// WHAT ACTUALLY FIRED, and the REDUCER form.
//
// One harness for both, because both claims live on the same page: the lane
// emits no cmds at all (so its fired panel is a column of dashes, which is a
// fact and not a blank), and the resilient-fetch reducer emits `do_fetch` from
// INSIDE a cell body — the cmd no chart declares, and the one the declarative
// button row therefore cannot show.
// ═══════════════════════════════════════════════════════════════════════════

const rSamples: Samples<typeof fetchReducerChart> = {
  fetch: { url: "u://x", at: 1_000 },
  fetch_ok: { url: "u://x", body: "hi", at: 1_010 },
  fetch_err: { url: "u://x", error: "boom", at: 1_020 },
  deadline_exceeded: { id: "retry" as SubId, atMs: 1_030 },
};

async function mountReducer(): Promise<void> {
  await act(async () => {
    root.render(
      <ReducerChartInspector
        chart={fetchReducerChart}
        parts={{ assign: rAssign, cells: rCells }}
        boot={fetchReducerBoot}
        samples={rSamples}
        title="resilient fetch"
      />,
    );
  });
  await act(async () => {});
}

/** The "cmds fired" rows, in step order: `[cause, what fired]`. */
function firedRows(): [string, string][] {
  return [...container.querySelectorAll(".tea-ci-fire")].map((el) => [
    el.querySelector(".tea-ci-fire-by")?.textContent ?? "",
    el.querySelector(".tea-ci-fire-cmds")?.textContent ?? "",
  ]);
}

describe("<ChartInspector> — the cmds that actually fired", () => {
  it("starts with the `init` step, whose cause is not a msg", async () => {
    await mount();
    expect(firedRows()).toEqual([["init", "—"]]);
  });

  it("adds one row per dispatch, tagged with the msg that caused it", async () => {
    await mount();
    await click(buttonFor("WIP"));
    await click(buttonFor("DONE"));
    // `lane` declares no cmds anywhere, so every row is an honest dash — the
    // panel says "nothing fired", never "no data".
    expect(firedRows()).toEqual([
      ["init", "—"],
      ["WIP", "—"],
      ["DONE", "—"],
    ]);
  });
});

describe("<ReducerChartInspector> — the form with no state dimension", () => {
  it("renders one control per event, and none of them can be refused", async () => {
    await mountReducer();
    expect([...controls().keys()]).toEqual([
      "fetch",
      "fetch_ok",
      "fetch_err",
      "deadline_exceeded",
    ]);
    for (const [, el] of controls()) {
      expect(el.dataset.status).toBe("legal");
    }
    expect(currentState()).toBe("idle");
  });

  it("omits the phase, and NAMES every question the form cannot answer", async () => {
    await mountReducer();
    expect(container.querySelector(".tea-ci-phase")).toBeNull();
    const omitted = [
      ...container.querySelectorAll<HTMLElement>("[data-omitted]"),
    ].map((el) => el.dataset.omitted);
    expect(omitted).toEqual(["phases", "refusals", "scope"]);
    expect(container.querySelector(".tea-ci-omits")?.textContent).toContain(
      "no state dimension",
    );
  });

  it("runs a cell purely and shows the target it actually picks", async () => {
    await mountReducer();
    // `onErr` is run against the live state and the sample, exactly as the grid
    // form runs one — the phase dimension is what this form lost, not purity.
    expect(controls().get("fetch_err")?.textContent).toContain(
      "→ waiting_retry",
    );
    // …and the whole declared fan-out is still one hover away.
    expect(buttonFor("fetch_err").title).toContain("waiting_retry");
  });

  it("shows the cmd a CELL built, which the chart declares nowhere", async () => {
    await mountReducer();
    // the declarative row for `fetch` names no cmd — the chart has none to name
    expect(controls().get("fetch")?.textContent).not.toContain("do_fetch");
    await click(buttonFor("fetch"));
    expect(currentState()).toBe("fetching");
    // …and the after panel has it, tagged with the msg that caused it.
    expect(firedRows()).toEqual([
      ["init", "—"],
      ["fetch", "do_fetch"],
    ]);
  });

  it("draws the reducer's one-node diagram, every edge leaving `any`", async () => {
    await mountReducer();
    const pre = container.querySelector(".tea-ci-mermaid")?.textContent ?? "";
    expect(pre).toContain("[*] --> idle");
    expect(pre).toContain("any --> fetching : fetch / attempt()");
    // no highlight: there is no node that IS the current state.
    expect(pre).not.toContain("teaActive");
  });
});
