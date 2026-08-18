// @vitest-environment happy-dom
// ═══════════════════════════════════════════════════════════════════════════
// <LaneView> / <LiveLaneView> — a real fabrika lane, rendered for real.
//
// Same harness as `src/chart/inspect/react.test.tsx`: a real `react-dom/client`
// root under happy-dom, driven with `act`. No renderer mocks.
//
// AND THE DATA IS REAL. Every replay assertion below is driven from
// `report/__fixtures__/real/` — bytes the `fabrika` binary wrote, including the
// four-phase epic whose phase 2 holds eight tasks with six of them untouched.
// That epic is the exact shape `report.ts` learned its editorial rule from, so
// it is the one that can prove the rule was applied rather than described.
//
// Nothing below tells the component a task id, a state name, a phase name or a
// standing: every one of those is read out of the DOM, and the strongest
// assertions check it against `fabrika lane status`'s OWN stdout.
// ═══════════════════════════════════════════════════════════════════════════
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  REAL_CODER,
  REAL_EPIC,
  REAL_FROZEN,
} from "../report/__fixtures__/real";
import { parseEventsJsonl, parseStatusJson } from "../report/fold";
import { chartFromWorkflowText } from "../report/workflow";
import { coderParts, epic } from "./__fixtures__/epic-run";
import { LaneView, LiveLaneView } from "./react";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

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

/** One real lane, through the same door a consumer holding the files has. */
const laneOf = (real: typeof REAL_EPIC) => ({
  lane: chartFromWorkflowText(real.workflowJson),
  log: parseEventsJsonl(real.eventsJsonl),
  status: parseStatusJson(real.statusStdout),
});

async function mountReplay(real: typeof REAL_EPIC): Promise<void> {
  const { lane, log } = laneOf(real);
  await act(async () => {
    root.render(<LaneView lane={lane} log={log} />);
  });
}

// ── DOM readers. Nothing here names a task, a state or a phase. ───────────

/** Every phase panel on screen, in order: `[name, standing]`. */
const phases = (): [string, string][] =>
  [...container.querySelectorAll<HTMLElement>("[data-phase]")].map((el) => [
    el.dataset.phase as string,
    el.dataset.standing as string,
  ]);

/** The chips of one phase: task → the leaf it is in. */
function chips(phase: string): Record<string, string> {
  const panel = container.querySelector(`[data-phase="${phase}"]`);
  const out: Record<string, string> = {};
  for (const el of panel?.querySelectorAll<HTMLElement>(".tea-lv-chip") ?? []) {
    out[el.dataset.task as string] = el.dataset.state as string;
  }
  return out;
}

/** The tasks drawn in FULL — the editorial rule's output, read off the DOM. */
const expanded = (): string[] =>
  [...container.querySelectorAll<HTMLElement>('[data-expanded="true"]')].map(
    (el) => el.dataset.task as string,
  );

/** The tasks of one phase collapsed behind a disclosure. */
const collapsed = (phase: string): string[] =>
  [
    ...(container
      .querySelector(`[data-phase="${phase}"]`)
      ?.querySelectorAll<HTMLElement>(".tea-lv-collapsed") ?? []),
  ].map((el) => el.dataset.task as string);

const stuckRows = (): [string, string][] =>
  [...container.querySelectorAll<HTMLElement>("[data-stuck]")].map((el) => [
    el.dataset.task as string,
    el.dataset.stuck as string,
  ]);

const controlsOf = (task: string): HTMLElement[] => [
  ...container.querySelectorAll<HTMLElement>(`.tea-lv-ev[data-task="${task}"]`),
];

const range = (): HTMLInputElement =>
  container.querySelector('input[type="range"]') as HTMLInputElement;

async function drag(el: HTMLInputElement, to: number): Promise<void> {
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value",
    )?.set;
    setter?.call(el, String(to));
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

/** Open a `<details>` the way a reader does — the `toggle` the lazy body waits for. */
async function open(el: HTMLDetailsElement): Promise<void> {
  await act(async () => {
    el.open = true;
    el.dispatchEvent(new Event("toggle"));
  });
  await act(async () => {});
}

async function click(el: HTMLElement): Promise<void> {
  await act(async () => {
    el.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
  await act(async () => {});
}

// ═══════════════════════════════════════════════════════════════════════════
// REPLAY — the fabrika case
// ═══════════════════════════════════════════════════════════════════════════

describe("<LaneView> — the lane's own structure, derived", () => {
  it("draws every phase in order, with the standing the fold derives", async () => {
    await mountReplay(REAL_EPIC);
    expect(phases()).toEqual([
      ["phase1", "complete"],
      ["phase2", "active"],
      ["phase3", "waiting"],
      ["epic", "waiting"],
    ]);
  });

  it("shows every task's leaf, and they are `lane status`'s own answer", async () => {
    await mountReplay(REAL_EPIC);
    const { status } = laneOf(REAL_EPIC);
    // The CLI printed `{ phase2: { issue_4240: "review", … } }`. The page never
    // saw that file — it folded the log — so this is the driver and the drawing
    // agreeing about eight tasks at once.
    const printed = status.stateValue as Record<string, Record<string, string>>;
    expect(chips("phase2")).toEqual(printed.phase2);
  });

  it("names the active phase and the lane's status in the header", async () => {
    await mountReplay(REAL_EPIC);
    expect(container.querySelector(".tea-lv-phase")?.textContent).toBe(
      "phase2",
    );
    expect(
      container.querySelector<HTMLElement>("[data-lane-status]")?.dataset
        .laneStatus,
    ).toBe("active");
  });
});

describe("<LaneView> — the page says it in words, and they are true", () => {
  const head = () => container.querySelector(".tea-lv-head")?.textContent ?? "";
  const statusPill = () =>
    container.querySelector(".tea-lv-status")?.textContent ?? "";
  const phaseHead = (phase: string) =>
    container.querySelector(`[data-phase="${phase}"] .tea-lv-h`)?.textContent ??
    "";

  it("badges a lane that FROZE as stopped, never as done", async () => {
    await mountReplay(REAL_FROZEN);
    // `deriveLaneStatus` emits fabrika's `done | active`, and printing it raw
    // put the word DONE one span away from the word `tripped`.
    expect(container.querySelector(".tea-lv-terminal")?.textContent).toBe(
      "tripped",
    );
    expect(statusPill()).toBe("stopped here");
    await mountReplay(REAL_CODER);
    expect(statusPill()).toBe("finished");
    await mountReplay(REAL_EPIC);
    expect(statusPill()).toBe("still running");
  });

  it("counts a phase's tasks without claiming they are running", async () => {
    await mountReplay(REAL_EPIC);
    // `N tasks running together` is what a phase is FOR, and it was printed on
    // the ones that had finished and the ones that had not started.
    expect(phaseHead("phase2")).toContain("8 tasks, running together");
    expect(phaseHead("phase1")).toContain("all finished");
    expect(phaseHead("phase1")).not.toContain("running");
    expect(phaseHead("phase3")).toContain("not started");
    expect(phaseHead("phase3")).not.toContain("running");
    // …and one task is never "1 task running together"
    await mountReplay(REAL_CODER);
    expect(phaseHead("pipeline")).toContain("1 task, all finished");
  });

  it("speaks of a trip that already happened in the past tense", async () => {
    await mountReplay(REAL_FROZEN);
    const waiting =
      container.querySelector(".tea-lv-waiting")?.textContent ?? "";
    // Four surfaces said the lane HAD tripped; this one said it was about to.
    expect(waiting).toContain("stopped the lane");
    expect(waiting).not.toContain("will trip");
    expect(waiting).not.toContain("siblings");
  });

  it("separates its labels in the MARKUP, for a host with no stylesheet", async () => {
    await mountReplay(REAL_FROZEN);
    // With the sheet absent every `gap` goes with it, and the header read
    // `5674 — NO STYLESHEETreplaytrippeddone`. The reading order is the
    // markup's job; the sheet only makes it quiet.
    expect(head()).toContain(" · replay · ");
    expect(head()).toContain("tripped · stopped here");
    expect(phaseHead("pipeline")).toContain(" · ");
  });
});

describe("<LaneView> — the wall of diagrams, prevented", () => {
  it("expands only the tasks that MOVED, and collapses the six that did not", async () => {
    await mountReplay(REAL_EPIC);
    // phase2 holds eight tasks; two have moved. This is the exact shape
    // `report.ts` learned the rule from, and eight diagrams is what it is for.
    expect(Object.keys(chips("phase2"))).toHaveLength(8);
    expect(expanded()).toEqual(["issue_4240", "issue_4241"]);
    // the six that did not move are collapsed — six pictures, not six walls
    expect(collapsed("phase2")).toEqual([
      "issue_4242",
      "issue_4243",
      "issue_4244",
      "issue_4245",
      "issue_4246",
      "issue_4247",
    ]);
  });

  it("still offers the collapsed task's picture — behind a disclosure", async () => {
    await mountReplay(REAL_EPIC);
    const untouched = container.querySelector<HTMLDetailsElement>(
      '.tea-lv-collapsed[data-task="issue_4242"]',
    );
    expect(untouched).toBeTruthy();
    // the screen's one concession over a comment: dropped from the flow, not
    // dropped from the page.
    expect(untouched?.tagName).toBe("DETAILS");
    // …and the region is still DISPATCHABLE from behind the fold: the controls
    // are in the DOM whether or not anyone opened it. That is the promise the
    // collapse makes, and it is the half that must not be lazy.
    expect(untouched?.querySelectorAll(".tea-lv-ev").length).toBeGreaterThan(0);
    await open(untouched as HTMLDetailsElement);
    expect(untouched?.querySelector(".tea-lv-mermaid")?.textContent).toContain(
      "stateDiagram-v2",
    );
  });

  it("does not PAY for the diagrams it folded away until they are opened", async () => {
    await mountReplay(REAL_EPIC);
    // The wall is twelve `<pre class="mermaid">` and a host renders every one
    // of them — closed `<details>` or not. Keyed by their own text, one step of
    // the scrubber remounted and re-rendered all twelve, and the first paint of
    // that page timed out a thirty-second screenshot. The fold has to cost what
    // it looks like it costs.
    const drawn = () => container.querySelectorAll(".tea-lv-mermaid").length;
    expect(drawn()).toBe(expanded().length);
    const one = container.querySelector<HTMLDetailsElement>(
      '.tea-lv-collapsed[data-task="issue_4242"]',
    ) as HTMLDetailsElement;
    await open(one);
    expect(drawn()).toBe(expanded().length + 1);
  });

  it("when NOTHING in the active phase has moved, one task represents it", async () => {
    await mountReplay(REAL_EPIC);
    // step 8 is the moment phase1 finished: phase2 is active and every one of
    // its eight tasks is still at its entry state.
    await drag(range(), 8);
    expect(new Set(Object.values(chips("phase2")))).toEqual(
      new Set(["queued"]),
    );
    expect(expanded()).toHaveLength(1);
  });
});

describe("<LaneView> — nothing is dispatchable, and it says why", () => {
  it("draws every control as unavailable, with the reason on screen", async () => {
    await mountReplay(REAL_EPIC);
    const controls = controlsOf("issue_4240");
    expect(controls.length).toBeGreaterThan(0);
    for (const el of controls) {
      expect(el.dataset.sendable).toBe("false");
      expect(el.querySelector("button")?.disabled).toBe(true);
    }
    // …and the reason is TEXT, not a tooltip nobody hovers — said ONCE for the
    // view rather than on each control. It is a fact about the SOURCE, identical
    // for every control, and a phase of eight tasks × six events printed it
    // forty-eight times until a real lane was rendered and looked at. The button
    // keeps it as its `title`, so no affordance is silently missing.
    const banner = document.querySelectorAll('[data-unavailable="dispatch"]');
    expect(banner).toHaveLength(1);
    const reason = banner[0]?.textContent ?? "";
    expect(reason).toContain("code bodies");
    // ONCE on the page, and the count is what matters: this sentence shipped on
    // every control, and a phase of eight tasks × six events said it 48 times.
    // Counting elements with the attribute would not have caught that.
    expect(container.textContent?.split(reason)).toHaveLength(2);
    const legal = controls.find((el) => el.dataset.status === "legal");
    expect(legal?.querySelector("button")?.title).toContain("code bodies");
  });

  it("keeps a refused control on screen with the mechanism that refused it", async () => {
    await mountReplay(REAL_EPIC);
    // `issue_4241` is parked at `blocked`, which routes only the resume event.
    const refused = controlsOf("issue_4241").filter(
      (el) => el.dataset.status === "refused",
    );
    expect(refused.length).toBeGreaterThan(0);
    // …and it names the pair that is missing rather than a phase. `WIP` is
    // `edges`-scoped, so the phase never had anything to do with the refusal.
    expect(refused[0]?.textContent).toContain('declares no "WIP" edge');
  });
});

describe("<LaneView> — the timeline, and the scrubber over it", () => {
  it("lists every logged step with the log's OWN timestamps", async () => {
    await mountReplay(REAL_EPIC);
    const { log } = laneOf(REAL_EPIC);
    const rows = [...container.querySelectorAll("[data-step]")];
    expect(rows).toHaveLength(log.length);
    expect(rows[0]?.textContent).toContain(log[0]?.at);
    // a log stamps every line, so the clock is answered rather than excused
    expect(container.querySelector('[data-unavailable="clock"]')).toBeNull();
  });

  it("gives the mermaid host a NEW node every time the drawing changes", async () => {
    await mountReplay(REAL_EPIC);
    // Every mermaid host marks what it has rendered (`data-processed`) and
    // skips those nodes forever. React updating in place rewrites only the
    // TEXT, so the host skips the node and from the second frame on the reader
    // sees mermaid source instead of a picture. A key derived from the content
    // forces an unmount/remount — and a `key` has no DOM projection, so only
    // node IDENTITY can tell the two worlds apart.
    const node = () =>
      container.querySelector('[data-task="issue_4240"] .tea-lv-mermaid');
    const first = node();
    expect(first?.textContent).toContain("stateDiagram-v2");
    await drag(range(), 9);
    expect(node()?.textContent).toContain("stateDiagram-v2");
    expect(node()).not.toBe(first);
  });

  it("says what the chip cannot, and never repeats it", async () => {
    await mountReplay(REAL_EPIC);
    // The collapsed summary sits directly under a chip row that already said
    // `task = state` for every task in the phase. Repeating it there lists each
    // task twice, adjacent — which reads as a bug and was one.
    const summary = container.querySelector(
      '.tea-lv-collapsed[data-task="issue_4242"] > summary',
    )?.textContent;
    expect(summary).toContain("issue_4242");
    expect(summary).not.toContain("=");
    // …and it says the one thing the chip does not: whether this has begun. Not
    // "not started" — that chart's `initial` can BE the state on the chip, and
    // the two then contradicted each other on screen.
    expect(summary).toContain(`still at ${chips("phase2").issue_4242}`);
  });

  it("scrubbing back re-folds the prefix — the state AT that step", async () => {
    await mountReplay(REAL_EPIC);
    expect(chips("phase2").issue_4240).toBe("review");
    await drag(range(), 9);
    // nine events in: `issue_4240` has had WIP and nothing else.
    expect(chips("phase2").issue_4240).toBe("build");
    expect(phases()[1]?.[1]).toBe("active");
    await drag(range(), 0);
    expect(phases()[0]?.[1]).toBe("active");
    expect(new Set(Object.values(chips("phase1")))).toEqual(
      new Set(["queued"]),
    );
  });
});

describe("<LaneView> — which of twelve things is stuck", () => {
  it("says so out loud when nothing is", async () => {
    await mountReplay(REAL_CODER);
    expect(stuckRows()).toEqual([]);
    expect(container.querySelector(".tea-lv-stuck")?.textContent).toContain(
      "nothing is stuck",
    );
  });

  it("names the task, its phase and WHY on a lane that tripped", async () => {
    await mountReplay(REAL_FROZEN);
    expect(stuckRows()).toEqual([["issue", "tripped"]]);
    const panel = container.querySelector(".tea-lv-stuck")?.textContent ?? "";
    expect(panel).toContain("error final");
    expect(panel).toContain("tripped: issue");
    // and the lane's own terminal is on the header, not only the task's
    expect(container.querySelector(".tea-lv-terminal")?.textContent).toBe(
      "tripped",
    );
  });

  it("shows the retry budget only once it is worth something", async () => {
    await mountReplay(REAL_FROZEN);
    // the real 5674 run spent 2/2 before freezing — `0/2` would be noise, `2/2`
    // is the whole story, and this lane's own status file says which it is.
    const { status } = laneOf(REAL_FROZEN);
    const ctx = status.context.issue as { retries: number };
    expect(ctx.retries).toBe(2);
    expect(container.querySelector(".tea-lv-retries")?.textContent).toContain(
      "2/2",
    );
    await drag(range(), 0);
    expect(container.querySelector(".tea-lv-retries")).toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// LIVE — the same panels over a lane that is running
// ═══════════════════════════════════════════════════════════════════════════

const hands = {
  issue_1: {
    parts: coderParts,
    boot: () => ({ type: "queued", retries: 0, maxRetries: 2 }) as const,
  },
  issue_2: {
    parts: coderParts,
    boot: () => ({ type: "queued", retries: 0, maxRetries: 2 }) as const,
  },
  issue_3: {
    parts: coderParts,
    boot: () => ({ type: "queued", retries: 0, maxRetries: 5 }) as const,
  },
};

const samples = {
  issue_1: {
    WIP: { at: 1 },
    DONE: { at: 2 },
    PASS: { at: 3 },
    FAIL: { at: 4, reason: "flaky" },
    BLOCKED: { at: 5, reason: "review backed up" },
    UNBLOCKED: { at: 6 },
  },
} as const;

async function mountLive(): Promise<void> {
  await act(async () => {
    root.render(<LiveLaneView lane={epic} hands={hands} samples={samples} />);
  });
  // one more flush for the `ready` capture that swaps "booting…" for the view
  await act(async () => {});
}

const buttonFor = (task: string, event: string): HTMLButtonElement =>
  container
    .querySelector(`.tea-lv-ev[data-task="${task}"][data-event="${event}"]`)
    ?.querySelector("button") as HTMLButtonElement;

describe("<LiveLaneView> — the same page, with the code bodies", () => {
  it("renders the same panels from the running lane", async () => {
    await mountLive();
    expect(phases()).toEqual([
      ["phase1", "active"],
      ["phase2", "waiting"],
    ]);
    expect(
      container.querySelector<HTMLElement>("[data-source]")?.dataset.source,
    ).toBe("live");
  });

  it("OFFERS the controls the replay source refuses to offer", async () => {
    await mountLive();
    expect(buttonFor("issue_1", "WIP").disabled).toBe(false);
    expect(buttonFor("issue_2", "WIP").disabled).toBe(false);
    // …and nothing on the page says "cannot dispatch": the code bodies are
    // here, which is the ONE thing the replay source does not have.
    expect(
      container.querySelector('.tea-lv-ev [data-unavailable="dispatch"]'),
    ).toBeNull();
  });

  it("a click moves the lane, and the whole page re-derives", async () => {
    await mountLive();
    await click(buttonFor("issue_1", "WIP"));
    expect(chips("phase1").issue_1).toBe("build");
    // …and the sibling did not move: the tasks are independent regions
    expect(chips("phase1").issue_2).toBe("queued");
    expect(expanded()).toEqual(["issue_1"]);
  });

  it("advances the LANE when every region of a phase reaches a final", async () => {
    await mountLive();
    for (const task of ["issue_1", "issue_2"]) {
      for (const event of ["WIP", "DONE", "PASS", "DONE"]) {
        await click(buttonFor(task, event));
      }
    }
    expect(phases()).toEqual([
      ["phase1", "complete"],
      ["phase2", "active"],
    ]);
  });

  it("a tape carries ORDER and no clock — and the timeline says so", async () => {
    await mountLive();
    await click(buttonFor("issue_1", "WIP"));
    const rows = [...container.querySelectorAll("[data-step]")];
    expect(rows).toHaveLength(1);
    expect(rows[0]?.textContent).toContain("issue_1");
    expect(rows[0]?.textContent).toContain("queued → build");
    const clock = container.querySelector('[data-unavailable="clock"]');
    expect(clock?.textContent).toContain("no wall-clock");
  });

  it("scrubbing time-travels by pure replay, and `now` comes back", async () => {
    await mountLive();
    await click(buttonFor("issue_1", "WIP"));
    await click(buttonFor("issue_1", "DONE"));
    expect(chips("phase1").issue_1).toBe("review");
    await drag(range(), 1);
    expect(chips("phase1").issue_1).toBe("build");
    const now = [...container.querySelectorAll("button")].find(
      (b) => b.textContent === "now",
    ) as HTMLButtonElement;
    await click(now);
    expect(chips("phase1").issue_1).toBe("review");
  });

  it("will not dispatch into the PRESENT while showing the PAST", async () => {
    await mountLive();
    await click(buttonFor("issue_1", "WIP"));
    await click(buttonFor("issue_1", "DONE"));
    await drag(range(), 0);
    // The page is showing step 0 and the machine is at `review`. Every button
    // used to be live, computing its outcome from the state ON SCREEN and
    // dispatching into the state that is actually there — so a click both
    // mis-stated what it would do and gave no sign it had done it. The only
    // feedback was the step count going from `2` to `3`.
    expect(chips("phase1").issue_1).toBe("queued");
    expect(buttonFor("issue_1", "WIP").disabled).toBe(true);
    const why = container.querySelector('[data-unavailable="dispatch"]');
    expect(why?.textContent).toContain("step 0 of 2");
    // …and the reason travels with the button, so no affordance is silently off
    expect(buttonFor("issue_1", "WIP").title).toContain("step 0 of 2");

    const before = range().max;
    await click(buttonFor("issue_1", "WIP"));
    expect(range().max).toBe(before);

    // and `now` gives them back
    const now = [...container.querySelectorAll("button")].find(
      (b) => b.textContent === "now",
    ) as HTMLButtonElement;
    await click(now);
    expect(buttonFor("issue_1", "PASS").disabled).toBe(false);
    expect(container.querySelector('[data-unavailable="dispatch"]')).toBeNull();
  });

  it("records no step the lane refused — every row on it is a walk", async () => {
    await mountLive();
    await click(buttonFor("issue_1", "WIP"));
    await click(buttonFor("issue_1", "DONE"));
    // The one way this page could put a no-op on its own timeline was a click
    // dispatched from a scrubbed state into the present; the chart refuses
    // everything else before it reaches the runtime. `view.test.ts` pins how a
    // refused entry RENDERS if a tape arrives holding one.
    expect(buttonFor("issue_1", "WIP").disabled).toBe(true);
    const rows = [...container.querySelectorAll("[data-step]")];
    expect(rows).toHaveLength(2);
    for (const row of rows) expect(row.getAttribute("data-refused")).toBeNull();
  });

  it("shows the retry budget off the REGION's own state", async () => {
    await mountLive();
    for (const event of ["WIP", "DONE", "FAIL"]) {
      await click(buttonFor("issue_1", event));
    }
    // the guarded arm held: back to `build`, one retry spent out of two.
    expect(chips("phase1").issue_1).toBe("build");
    expect(
      container.querySelector('[data-task="issue_1"] .tea-lv-retries')
        ?.textContent,
    ).toContain("1/2");
  });
});
