// @vitest-environment happy-dom
import { act, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DispatchDiscardedError,
  defineMachine,
  type OnError,
  StoreConflictError,
} from "../index";
import { memoryStore } from "../mem";
import { run } from "../promise";
import { useMachine } from "./index";

// `useMachine` has to take the `onError` a fenced store needs (ADR 0031), and
// read it the way it reads handlers: from the latest render, without replacing
// the run.

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

type State = { readonly count: number };
type Msg = { readonly type: "bump" };

const machine = defineMachine({
  types: { model: {} as State, msg: {} as Msg, ctx: undefined },
  init: (loaded) => [loaded ?? { count: 0 }, []],
  update: { bump: (state) => [{ count: state.count + 1 }, []] },
});

describe("useMachine's onError", () => {
  let root: Root;
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
  });

  it("a failed step reaches the run's sink once, and a later send reports a discard", async () => {
    const failure = new Error("reducer threw");
    const failing = defineMachine({
      types: { model: {} as State, msg: {} as Msg, ctx: undefined },
      init: () => [{ count: 0 }, []],
      update: {
        bump: () => {
          throw failure;
        },
      },
    });
    const onError = vi.fn<OnError>();
    let send!: (msg: Msg) => void;
    function Page() {
      const [state, sender] = useMachine(failing, {
        run,
        ctx: undefined,
        onError,
      });
      send = sender;
      return <span>{state.count}</span>;
    }
    await act(async () => root.render(<Page />));
    await act(async () => {
      expect(send({ type: "bump" })).toBeUndefined();
    });
    expect(onError).toHaveBeenCalledExactlyOnceWith(failure, {
      phase: "reduce",
    });
    expect(container.textContent).toBe("0");
    expect(send({ type: "bump" })).toBeUndefined();
    expect(onError).toHaveBeenLastCalledWith(
      expect.any(DispatchDiscardedError),
      { phase: "discard" },
    );
    expect(onError).toHaveBeenCalledTimes(2);
  });

  it("a lost fence reaches the latest render's sink, and a new sink does not replace the run", async () => {
    const store = memoryStore<State>(null, undefined, { fenced: true });
    const first = vi.fn<OnError>();
    const latest = vi.fn<OnError>();
    const boots = vi.spyOn(store, "loadFenced");
    let dispatch!: (msg: Msg) => void;

    function Page({ onError }: { readonly onError: OnError }) {
      const [, send] = useMachine(machine, {
        run,
        ctx: undefined,
        store,
        onError,
      });
      useEffect(() => {
        dispatch = send;
      });
      return null;
    }

    await act(async () => root.render(<Page onError={first} />));
    await act(async () => {
      expect(dispatch({ type: "bump" })).toBeUndefined();
    });
    await act(async () => root.render(<Page onError={latest} />));
    expect(boots).toHaveBeenCalledTimes(1);

    // A second writer takes the fence, and this run finds out with no caller.
    const taker = await run(machine, {
      ctx: undefined,
      store,
      onError: () => {},
    }).ready;
    await taker.dispatch({ type: "bump" });
    await act(async () => root.unmount());
    root = createRoot(document.createElement("div"));

    expect(first).not.toHaveBeenCalled();
    expect(latest).toHaveBeenCalledWith(expect.any(StoreConflictError), {
      phase: "stop-save",
    });
    await taker.stop();
  });

  it("with no sink, a failure still goes to the default sink", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const never = new Promise<never>(() => {});
    const work = defineMachine({
      types: {
        model: {} as State,
        msg: {} as Msg,
        cmd: {} as { readonly type: "hang" },
        ctx: undefined,
      },
      init: (loaded) => [loaded ?? { count: 0 }, [{ type: "hang" as const }]],
      update: { bump: (state) => [state, []] },
    });

    function Page() {
      useMachine(work, {
        run,
        ctx: undefined,
        interpret: { hang: () => never },
      });
      return null;
    }

    vi.useFakeTimers();
    try {
      await act(async () => root.render(<Page />));
      // The unmount gives up on the handler: a `DrainTimeoutNotice`, which only
      // the default sink warns about.
      await act(async () => {
        root.unmount();
        await vi.advanceTimersByTimeAsync(6_000);
      });
      root = createRoot(document.createElement("div"));
      expect(warn).toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
      warn.mockRestore();
    }
  });
});
