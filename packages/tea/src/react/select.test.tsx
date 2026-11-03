// @vitest-environment happy-dom
import { act, type ReactNode, StrictMode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { run as runEffect } from "../effect";
import { reactTestScope } from "../effect/fixtures/react-scope";
import { defineMachine, type OnError } from "../index";
import { run } from "../promise";
import { useRuntime, type ViewHandle } from "./index";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

type Id = "a" | "b" | "c";
type View = { readonly n: number };
type State = { readonly views: Readonly<Record<Id, View>> };
type Msg = { readonly type: "inc"; readonly id: Id };
const machine = defineMachine({
  types: { model: {} as State, msg: {} as Msg, ctx: undefined },
  init: () => [{ views: { a: { n: 0 }, b: { n: 10 }, c: { n: 20 } } }, []],
  update: {
    inc: (s, m) => [
      {
        views: { ...s.views, [m.id]: { n: s.views[m.id].n + 1 } },
      },
      [],
    ],
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
  vi.restoreAllMocks();
});
const render = (node: ReactNode) => act(async () => root.render(node));

describe.each([
  "promise",
  "effect",
] as const)("useRuntime selectors on %s", (engine) => {
  let owner: {
    handle: ViewHandle<State, Msg>;
    idle(): Promise<void>;
    close(): Promise<void>;
  };
  beforeEach(async () => {
    const opts = { ctx: undefined, onError: vi.fn<OnError>() };
    if (engine === "promise") {
      const handle = await run(machine, opts).ready;
      owner = {
        handle,
        idle: () => handle.idle(),
        close: () => handle.stop(),
      };
    } else {
      const scope = await reactTestScope();
      const booting = await scope.run(runEffect(machine, opts));
      const handle = await scope.run(booting.ready);
      owner = {
        handle,
        idle: () => scope.run(handle.idle()),
        close: () => scope.close(),
      };
    }
  });
  afterEach(async () => owner.close());

  it("redraws a reader when its selected part changes", async () => {
    const drew = vi.fn();
    function Reader() {
      const [view, send] = useRuntime(owner.handle, (s) => s.views.a);
      drew();
      return (
        <button type="button" onClick={() => send({ type: "inc", id: "a" })}>
          {view.n}
        </button>
      );
    }
    await render(<Reader />);
    expect(container.textContent).toBe("0");
    await act(async () => {
      container.querySelector("button")?.click();
      await owner.idle();
    });
    expect(container.textContent).toBe("1");
    expect(drew).toHaveBeenCalledTimes(2);
  });

  it("does not redraw readers whose selected parts did not change", async () => {
    const draws = { a: vi.fn(), b: vi.fn(), c: vi.fn() };
    let send!: (msg: Msg) => void;
    function Reader({ id }: { id: Id }) {
      const [view, sender] = useRuntime(owner.handle, (s) => s.views[id]);
      send = sender;
      draws[id]();
      return (
        <p>
          {id}: {view.n}
        </p>
      );
    }
    await render(
      <>
        <Reader id="a" />
        <Reader id="b" />
        <Reader id="c" />
      </>,
    );
    for (const id of ["b", "b", "b"] as const) {
      await act(async () => {
        send({ type: "inc", id });
        await owner.idle();
      });
    }
    expect(draws.a).toHaveBeenCalledTimes(1);
    expect(draws.b).toHaveBeenCalledTimes(4);
    expect(draws.c).toHaveBeenCalledTimes(1);
    expect(
      [...container.querySelectorAll("p")].map((p) => p.textContent),
    ).toEqual(["a: 0", "b: 13", "c: 20"]);
  });

  it("reads the new prop's part on the render where the prop changes", async () => {
    const saw = vi.fn<(view: View) => void>();
    function Reader({ id }: { id: Id }) {
      const [view] = useRuntime(owner.handle, (s) => s.views[id]);
      saw(view);
      return <p>{view.n}</p>;
    }
    await render(<Reader id="a" />);
    saw.mockClear();
    await render(<Reader id="b" />);
    expect(saw).toHaveBeenCalledExactlyOnceWith(
      owner.handle.getState().views.b,
    );
    expect(container.textContent).toBe("10");
  });

  it("keeps a returnless whole-run send across renders and selector changes", async () => {
    let send!: (msg: Msg) => void;
    const onError = vi.fn<OnError>();
    function Reader({ id }: { id: Id }) {
      const [view, sender] = useRuntime(owner.handle, (s) => s.views[id], {
        onError,
      });
      send = sender;
      return <p>{view.n}</p>;
    }
    await render(<Reader id="a" />);
    const kept = send;
    await act(async () => {
      expect(kept({ type: "inc", id: "a" })).toBeUndefined();
      await owner.idle();
    });
    expect(container.textContent).toBe("1");
    expect(send).toBe(kept);
    await render(<Reader id="b" />);
    expect(send).toBe(kept);
    await act(async () => {
      expect(kept({ type: "inc", id: "b" })).toBeUndefined();
      await owner.idle();
    });
    expect(container.textContent).toBe("11");
    expect(send).toBe(kept);
    expect(owner.handle.getState().views.a.n).toBe(1);
    expect(onError).not.toHaveBeenCalled();
  });

  it("selects a stable part under StrictMode without snapshot warnings", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    let send!: (msg: Msg) => void;
    function Reader() {
      const [view, sender] = useRuntime(owner.handle, (s) => s.views.a);
      send = sender;
      return <p>{view.n}</p>;
    }
    await render(
      <StrictMode>
        <Reader />
      </StrictMode>,
    );
    await act(async () => {
      send({ type: "inc", id: "a" });
      await owner.idle();
    });
    expect(container.textContent).toBe("1");
    expect(logged).not.toHaveBeenCalled();
  });
});

it("selects and redraws a hand-built ViewHandle", async () => {
  let state = machine.init(null, undefined)[0];
  const listeners = new Set<() => void>();
  const handle: ViewHandle<State, Msg> = {
    getState: () => state,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    dispatch: async (msg) => {
      state = {
        views: { ...state.views, [msg.id]: { n: state.views[msg.id].n + 1 } },
      };
      for (const listener of listeners) listener();
    },
  };
  function Reader() {
    const [view, send] = useRuntime(handle, (s) => s.views.a);
    return (
      <button type="button" onClick={() => send({ type: "inc", id: "a" })}>
        {view.n}
      </button>
    );
  }
  await render(<Reader />);
  expect(container.textContent).toBe("0");
  await act(async () => container.querySelector("button")?.click());
  expect(container.textContent).toBe("1");
});
