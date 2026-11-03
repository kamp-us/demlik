// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { defineMachine, type OnError } from "../index";
import { run } from "../promise";
import { bridgeRuntime, passThroughMsg } from "./bridge";
import { createBackgroundRuntimeContext, useBackgroundRuntime } from "./react";
import { fakeChrome } from "./test-utils";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

type State = { readonly n: number };
type Msg = { readonly type: "inc" } | { readonly type: "boom" };
const failure = new Error("reducer threw");
const machine = defineMachine({
  types: { model: {} as State, msg: {} as Msg, ctx: undefined },
  init: () => [{ n: 0 }, []],
  update: {
    inc: (state) => [{ n: state.n + 1 }, []],
    boom: () => {
      throw failure;
    },
  },
});
const parseState = (raw: unknown): State | null => {
  if (typeof raw !== "object" || raw === null || !("n" in raw)) return null;
  return typeof raw.n === "number" ? { n: raw.n } : null;
};

let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  vi.stubGlobal("chrome", fakeChrome());
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

it.each([
  "default",
  "throwing",
] as const)("a transport failure stays loud with a %s sink", async (kind) => {
  const sinkFailure = new Error("sink threw");
  const sink = vi.fn<OnError>(() => {
    throw sinkFailure;
  });
  function Page() {
    const { state, dispatch } = useBackgroundRuntime<State, Msg>({
      channel: "absent",
      parseState,
      ...(kind === "throwing" ? { onError: sink } : {}),
    });
    return (
      <button
        type="button"
        onClick={() => {
          expect(dispatch({ type: "inc" })).toBeUndefined();
        }}
      >
        {state?.n ?? "waiting"}
      </button>
    );
  }
  vi.useFakeTimers();
  await act(async () => root.render(<Page />));
  expect(container.textContent).toBe("waiting");
  expect(sink).not.toHaveBeenCalled();
  await act(async () => container.querySelector("button")?.click());
  if (kind === "throwing") {
    expect(sink).toHaveBeenCalledExactlyOnceWith(expect.any(Error), {
      phase: "follow-up",
    });
    expect(() => vi.runOnlyPendingTimers()).toThrow(sinkFailure);
  } else {
    expect(() => vi.runOnlyPendingTimers()).toThrow(
      "Receiving end does not exist",
    );
  }
});

describe.each([
  "direct",
  "context",
] as const)("background React sender: %s", (kind) => {
  async function mount() {
    const hostError = vi.fn<OnError>();
    const runtime = await run(machine, {
      ctx: undefined,
      supervision: "escalate",
      onError: hostError,
    }).ready;
    const unbridge = bridgeRuntime(runtime, {
      channel: "counter",
      parseMsg: passThroughMsg,
    });
    const context = createBackgroundRuntimeContext<State, Msg>();
    const first = vi.fn<OnError>();
    let send!: (msg: Msg) => void;
    function View({
      state,
      dispatch,
    }: {
      state: State | null;
      dispatch: (msg: Msg) => void;
    }) {
      send = dispatch;
      return (
        <button
          type="button"
          onClick={() => {
            expect(dispatch({ type: "inc" })).toBeUndefined();
          }}
        >
          {state?.n ?? "waiting"}
        </button>
      );
    }
    function Direct({ onError }: { onError: OnError }) {
      return (
        <View
          {...useBackgroundRuntime<State, Msg>({
            channel: "counter",
            parseState,
            onError,
          })}
        />
      );
    }
    function Consumer() {
      const dispatch = context.useDispatch();
      const state = context.useState();
      const all = context.useRuntime();
      expect(all).toEqual({ state, dispatch });
      return <View state={state} dispatch={dispatch} />;
    }
    async function render(onError: OnError) {
      await act(async () =>
        root.render(
          kind === "direct" ? (
            <Direct onError={onError} />
          ) : (
            <context.Provider
              opts={{ channel: "counter", parseState, onError }}
            >
              <Consumer />
            </context.Provider>
          ),
        ),
      );
    }
    await render(first);
    return {
      runtime,
      unbridge,
      hostError,
      first,
      render,
      get send() {
        return send;
      },
    };
  }

  it("hydrates, then a click sends without waiting and draws the broadcast state", async () => {
    const mounted = await mount();
    try {
      expect(container.textContent).toBe("0");
      const kept = mounted.send;
      for (let n = 1; n <= 3; n++) {
        await act(async () => container.querySelector("button")?.click());
        expect(container.textContent).toBe(String(n));
        expect(mounted.runtime.getState()).toEqual({ n });
        expect(mounted.send).toBe(kept);
      }
      expect(mounted.first).not.toHaveBeenCalled();
      expect(mounted.hostError).not.toHaveBeenCalled();
    } finally {
      mounted.unbridge();
      await mounted.runtime.stop();
    }
  });

  it("a lost receiver reaches the latest sink once without replacing the sender", async () => {
    const mounted = await mount();
    const latest = vi.fn<OnError>();
    const kept = mounted.send;
    try {
      await mounted.render(latest);
      expect(mounted.send).toBe(kept);
      mounted.unbridge();
      await act(async () => container.querySelector("button")?.click());
      expect(latest).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({
          message: expect.stringContaining("Receiving end does not exist"),
        }),
        { phase: "follow-up" },
      );
      expect(mounted.first).not.toHaveBeenCalled();
      expect(mounted.hostError).not.toHaveBeenCalled();
      expect(container.textContent).toBe("0");
    } finally {
      mounted.unbridge();
      await mounted.runtime.stop();
    }
  });

  it("a background reducer failure belongs to the host's sink once", async () => {
    const mounted = await mount();
    try {
      await act(async () => {
        expect(mounted.send({ type: "boom" })).toBeUndefined();
        await mounted.runtime.idle();
      });
      expect(mounted.hostError).toHaveBeenCalledExactlyOnceWith(failure, {
        phase: "reduce",
      });
      expect(mounted.first).not.toHaveBeenCalled();
      await act(async () => container.querySelector("button")?.click());
      expect(container.textContent).toBe("1");
    } finally {
      mounted.unbridge();
      await mounted.runtime.stop();
    }
  });
});
