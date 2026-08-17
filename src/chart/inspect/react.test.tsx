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
import { assign, guards, lane } from "../__fixtures__/lane";
import type { Samples } from "./index";
import { ChartInspector } from "./react";

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
      expect(controls().get(e)?.textContent).toContain(
        "not addressed to phase",
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
