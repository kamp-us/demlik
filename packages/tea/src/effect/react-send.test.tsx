// @vitest-environment happy-dom
import { Effect, Exit, Scope } from "effect";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { run as runEffect } from "../effect";
import {
  DispatchDiscardedError,
  defineMachine,
  NoCellError,
  type OnError,
} from "../index";
import { run } from "../promise";
import { useRuntime, type ViewHandle } from "../react/index";

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
    inc: (s) => [{ n: s.n + 1 }, []],
    boom: () => {
      throw failure;
    },
  },
});

let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

describe.each(["promise", "effect"] as const)("useRuntime on %s", (engine) => {
  async function mount() {
    const ownError = vi.fn<OnError>();
    const opts = {
      ctx: undefined,
      onError: ownError,
      supervision: "escalate" as const,
    };
    const owner = await (async () => {
      if (engine === "promise") {
        const handle = await run(machine, opts).ready;
        return {
          handle,
          idle: () => handle.idle(),
          stop: () => handle.stop(),
          close: () => handle.stop(),
        };
      }
      const scope = await Effect.runPromise(Scope.make());
      const booting = await Effect.runPromise(
        runEffect(machine, opts).pipe(Scope.provide(scope)),
      );
      const handle = await Effect.runPromise(booting.ready);
      return {
        handle,
        idle: () => Effect.runPromise(handle.idle()),
        stop: () => Effect.runPromise(handle.stop()),
        close: () => Effect.runPromise(Scope.close(scope, Exit.void)),
      };
    })();
    const first = vi.fn<OnError>();
    let send!: (msg: Msg) => void;
    function Page({ onError }: { onError: OnError }) {
      const [state, sender] = useRuntime(owner.handle, { onError });
      send = sender;
      return (
        <button
          type="button"
          onClick={() => {
            expect(sender({ type: "inc" })).toBeUndefined();
          }}
        >
          {state.n}
        </button>
      );
    }
    const render = (onError: OnError) =>
      act(async () => root.render(<Page onError={onError} />));
    await render(first);
    return {
      ...owner,
      first,
      ownError,
      render,
      get send() {
        return send;
      },
    };
  }

  it("a click draws the new State, and step failures reach only the run's sink once", async () => {
    const mounted = await mount();
    try {
      for (let n = 1; n <= 3; n++) {
        await act(async () => {
          container.querySelector("button")?.click();
          await mounted.idle();
        });
        expect(container.textContent).toBe(String(n));
      }
      await act(async () => {
        expect(mounted.send({ type: "boom" })).toBeUndefined();
        await mounted.idle();
      });
      expect(mounted.ownError).toHaveBeenCalledExactlyOnceWith(failure, {
        phase: "reduce",
      });
      expect(mounted.first).not.toHaveBeenCalled();
      expect(container.textContent).toBe("3");

      await act(async () => {
        expect(
          mounted.send({ type: "unknown" } as unknown as Msg),
        ).toBeUndefined();
        await mounted.idle();
      });
      expect(mounted.ownError).toHaveBeenLastCalledWith(
        expect.any(NoCellError),
        { phase: "follow-up" },
      );
      expect(mounted.ownError).toHaveBeenCalledTimes(2);
      expect(mounted.first).not.toHaveBeenCalled();
    } finally {
      await mounted.close();
    }
  });

  it("stopped sends reach the latest hook sink as discards, with stable send identity", async () => {
    const mounted = await mount();
    const latest = vi.fn<OnError>();
    try {
      const kept = mounted.send;
      await mounted.render(latest);
      expect(mounted.send).toBe(kept);
      await mounted.stop();
      expect(kept({ type: "inc" })).toBeUndefined();
      expect(latest).toHaveBeenCalledExactlyOnceWith(
        expect.any(DispatchDiscardedError),
        { phase: "discard" },
      );
      expect(mounted.first).not.toHaveBeenCalled();
      expect(mounted.ownError).not.toHaveBeenCalled();
      expect(container.textContent).toBe("0");
    } finally {
      await mounted.close();
    }
  });

  it("unmount leaves the caller's run live", async () => {
    const mounted = await mount();
    try {
      await act(async () => root.render(null));
      expect(mounted.send({ type: "inc" })).toBeUndefined();
      await mounted.idle();
      expect(mounted.handle.getState()).toEqual({ n: 1 });
      expect(mounted.first).not.toHaveBeenCalled();
    } finally {
      await mounted.close();
    }
  });
});

it.each([
  "reject",
  "throw",
] as const)("a hand-built handle can %s and the hook reports it once", async (kind) => {
  const onError = vi.fn<OnError>();
  const state = { n: 0 };
  const handle: ViewHandle<State, Msg> = {
    subscribe: () => () => {},
    getState: () => state,
    dispatch: () => {
      if (kind === "throw") throw failure;
      return Promise.reject(failure);
    },
  };
  function Page() {
    const [snapshot, send] = useRuntime(handle, { onError });
    return (
      <button
        type="button"
        onClick={() => {
          expect(send({ type: "inc" })).toBeUndefined();
        }}
      >
        {snapshot.n}
      </button>
    );
  }
  await act(async () => root.render(<Page />));
  await act(async () => container.querySelector("button")?.click());
  expect(onError).toHaveBeenCalledExactlyOnceWith(failure, {
    phase: "follow-up",
  });
  expect(container.textContent).toBe("0");
});
