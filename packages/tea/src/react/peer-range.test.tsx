// @vitest-environment happy-dom
import * as React from "react";
import { type ReactNode, StrictMode, Suspense, useEffect } from "react";
import { version } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { defineMachine, type Store, type Sub, type Subscribe } from "../index";
import { memoryStore } from "../mem";
import { run } from "../promise";
import { useMachine } from "./index";

// ───────────────────────────────────────────────────────────────────────────
// #764 — the peer range is `^18 || ^19`, and React's effect order is not the same
// across it. Before 19.2 React skips an insertion cleanup in a deleted hidden
// tree, and only from 19.2 can a passive cleanup be a hide. So the root vitest
// config runs this one file on each React in `packages/tea/react-peers/`, and
// tea's own project runs it on the dev pin. It uses no `act`, which React 18.2
// does not export from `react`, and no name a React in the range lacks.
// ───────────────────────────────────────────────────────────────────────────

type Count = { readonly n: number };
type Inc = { readonly type: "inc" };
type Probe = Sub<"probe", { readonly name: string }>;

const machine = defineMachine({
  types: {
    model: {} as Count,
    msg: {} as Inc,
    sub: {} as Probe,
    ctx: undefined,
  },
  init: (loaded) => [loaded ?? { n: 0 }, []],
  update: { inc: (s) => [{ n: s.n + 1 }, []] },
  subs: [{ type: "probe", deps: () => ({ name: "p" }) }],
});

function parseCount(raw: unknown): Count | null {
  if (typeof raw !== "object" || raw === null) return null;
  const n = (raw as Record<string, unknown>).n;
  return typeof n === "number" ? { n } : null;
}

type ActivityType = (props: {
  mode: "visible" | "hidden";
  children: ReactNode;
}) => ReactNode;
const Activity = (React as { Activity?: ActivityType }).Activity;

/** One `useMachine` screen, with a counter on everything it starts and stops. */
function screen() {
  const store: Store<Count> = memoryStore<Count>(undefined, parseCount);
  const counts = { started: 0, stopped: 0, liveSubs: 0, subCleanups: 0 };
  const counted = ((...args: Parameters<typeof run>) => {
    counts.started += 1;
    const handle = run(...args);
    const stop = handle.stop;
    handle.stop = () => {
      counts.stopped += 1;
      return stop();
    };
    return handle;
  }) as typeof run;
  const subscribe = {
    probe: () => {
      counts.liveSubs += 1;
      return () => {
        counts.liveSubs -= 1;
        counts.subCleanups += 1;
      };
    },
  } satisfies Subscribe<Inc, Probe, undefined>;
  const slot: { dispatch: (msg: Inc) => Promise<void> } = {
    dispatch: () => Promise.reject(new Error("not rendered yet")),
  };
  function Screen({ children }: { children?: ReactNode }) {
    const [state, dispatch] = useMachine(machine, {
      run: counted,
      ctx: undefined,
      store,
      subscribe,
    });
    slot.dispatch = dispatch;
    return (
      <span>
        n={state.n}
        {children}
      </span>
    );
  }
  return { store, counts, slot, Screen };
}

/** A child that suspends for as long as `gate.pending` is set. */
function suspenseGate() {
  const gate: { pending: Promise<void> | null; release: () => void } = {
    pending: null,
    release: () => {},
  };
  const suspend = () => {
    gate.pending = new Promise<void>((resolve) => {
      gate.release = () => {
        gate.pending = null;
        resolve();
      };
    });
  };
  function Gate() {
    if (gate.pending !== null) throw gate.pending;
    return null;
  }
  return { gate, suspend, Gate };
}

const wrappers = [
  ["without Strict Mode", (node: ReactNode) => node],
  ["under Strict Mode", (node: ReactNode) => <StrictMode>{node}</StrictMode>],
] as const;

let container: HTMLDivElement;
let root: Root;

const rendered = async (node: ReactNode, text: string) => {
  root.render(node);
  await vi.waitFor(() => expect(container.textContent).toContain(text));
};

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  root.unmount();
  container.remove();
});

it("runs on the React its project names, with a matching react-dom", () => {
  expect(React.version).toBe(version);
  expect(React.version).toBe(process.env.TEA_REACT_PEER ?? React.version);
});

describe.each(wrappers)("useMachine %s", (_kind, wrap) => {
  /** A screen on show, one Msg folded, inside a boundary a sibling can suspend. */
  async function suspended() {
    const parts = screen();
    const suspense = suspenseGate();
    const page = (tick: number) =>
      wrap(
        <Suspense fallback={<i>loading</i>}>
          <parts.Screen />
          <suspense.Gate key="gate" data-tick={tick} />
        </Suspense>,
      );
    await rendered(page(0), "n=0");
    await vi.waitFor(() => expect(parts.counts.liveSubs).toBe(1));
    await parts.slot.dispatch({ type: "inc" });
    await vi.waitFor(() => expect(container.textContent).toContain("n=1"));

    suspense.suspend();
    await rendered(page(1), "loading");
    return { ...parts, ...suspense, page };
  }

  it.each([
    ["rendering it away", () => root.render(null)],
    ["unmounting the root", () => root.unmount()],
  ] as const)("leaves no run behind when a tree hidden by Suspense is deleted by %s", async (_how, remove) => {
    const { store, counts, slot, gate } = await suspended();
    expect(counts).toMatchObject({ started: 1, stopped: 0, liveSubs: 1 });

    remove();

    await vi.waitFor(() => expect(counts.stopped).toBe(1));
    expect(counts).toMatchObject({
      started: 1,
      stopped: 1,
      liveSubs: 0,
      subCleanups: 1,
    });
    await expect(slot.dispatch({ type: "inc" })).rejects.toThrow(
      "@demlik/tea: runtime stopped",
    );
    await expect(store.load()).resolves.toEqual({ n: 1 });
    gate.release();
  });

  it("keeps one live run while Suspense hides the tree and shows it again", async () => {
    const { counts, slot, gate, page } = await suspended();

    gate.release();
    await rendered(page(2), "n=1");
    await slot.dispatch({ type: "inc" });

    await vi.waitFor(() => expect(container.textContent).toContain("n=2"));
    expect(counts).toMatchObject({ started: 1, stopped: 0, liveSubs: 1 });
  });

  it("folds every Msg with one run and one Sub, then stops it on an unmount", async () => {
    const { store, counts, slot, Screen } = screen();
    await rendered(wrap(<Screen />), "n=0");
    await vi.waitFor(() => expect(counts.liveSubs).toBe(1));

    await slot.dispatch({ type: "inc" });
    await slot.dispatch({ type: "inc" });
    await vi.waitFor(() => expect(container.textContent).toContain("n=2"));
    expect(counts).toMatchObject({ started: 1, stopped: 0, liveSubs: 1 });

    root.render(null);

    await vi.waitFor(() => expect(counts.stopped).toBe(1));
    expect(counts).toMatchObject({ started: 1, liveSubs: 0 });
    await expect(store.load()).resolves.toEqual({ n: 2 });
    await expect(slot.dispatch({ type: "inc" })).rejects.toThrow(
      "@demlik/tea: runtime stopped",
    );
  });

  it("still takes a child's last Msg when a tree hidden by Suspense is deleted", async () => {
    const { store, counts, slot, Screen } = screen();
    const { suspend, gate, Gate } = suspenseGate();
    function LastWord() {
      useEffect(
        () => () => {
          void slot.dispatch({ type: "inc" }).catch(() => {});
        },
        [],
      );
      return null;
    }
    const page = (tick: number) =>
      wrap(
        <Suspense fallback={<i>loading</i>}>
          <Screen>
            <LastWord key="last-word" data-tick={tick} />
          </Screen>
          <Gate key="gate" data-tick={tick} />
        </Suspense>,
      );
    // Strict Mode's extra cleanup sends a Msg of its own on mount.
    await rendered(page(0), "n=");
    await vi.waitFor(() => expect(counts.liveSubs).toBe(1));
    await slot.dispatch({ type: "inc" });
    suspend();
    await rendered(page(1), "loading");
    const before = parseCount(await store.load())?.n ?? 0;

    root.render(null);

    await vi.waitFor(() => expect(counts.stopped).toBe(1));
    await vi.waitFor(async () =>
      expect(await store.load()).toEqual({ n: before + 1 }),
    );
    gate.release();
  });
});

// No React before 19.2 in the peer range exports an `<Activity>`, stable or not.
describe.runIf(Activity !== undefined)("useMachine under `<Activity>`", () => {
  const Boundary = Activity as ActivityType;

  it("keeps one run across a hide and show, and stops it when the hidden tree is deleted", async () => {
    const { counts, slot, Screen } = screen();
    const page = (mode: "visible" | "hidden") => (
      <Boundary mode={mode}>
        <Screen />
      </Boundary>
    );
    await rendered(page("visible"), "n=0");
    await vi.waitFor(() => expect(counts.liveSubs).toBe(1));

    root.render(page("hidden"));
    await vi.waitFor(() => expect(counts.liveSubs).toBe(0));
    root.render(page("visible"));
    await vi.waitFor(() => expect(counts.liveSubs).toBe(1));
    await slot.dispatch({ type: "inc" });
    expect(counts).toMatchObject({ started: 1, stopped: 0 });

    root.render(page("hidden"));
    await vi.waitFor(() => expect(counts.liveSubs).toBe(0));
    root.render(null);

    await vi.waitFor(() => expect(counts.stopped).toBe(1));
    await expect(slot.dispatch({ type: "inc" })).rejects.toThrow(
      "@demlik/tea: runtime stopped",
    );
  });
});
