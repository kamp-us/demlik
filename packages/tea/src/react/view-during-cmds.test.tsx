// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { defineMachine, type Reducer, type Store } from "../index";
import { memoryStore } from "../mem";
import { run } from "../promise";
import { useMachine } from "./index";

// A screen shows the State a machine is in while that State's Cmds run (#695).
// The test holds each Cmd's handler and reads the rendered page, so nothing here
// passes unless React really committed the phase during the Cmd.

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

type Phase = "idle" | "reading" | "thinking" | "writing" | "done";
type State = { readonly phase: Phase };
type Msg =
  | { readonly type: "go" }
  | { readonly type: "read" }
  | { readonly type: "thought" }
  | { readonly type: "wrote" };
type Step = { readonly type: "read" | "think" | "write" };

const update: Reducer<State, Msg, Step> = {
  go: () => [{ phase: "reading" }, [{ type: "read" }]],
  read: () => [{ phase: "thinking" }, [{ type: "think" }]],
  thought: () => [{ phase: "writing" }, [{ type: "write" }]],
  wrote: () => [{ phase: "done" }, []],
};

/** Moves through its phases after a `go`. */
const startedByMsg = defineMachine({
  types: {
    model: {} as State,
    msg: {} as Msg,
    cmd: {} as Step,
    ctx: undefined,
  },
  init: (loaded) => [loaded ?? { phase: "idle" }, []],
  update,
});

/** The same phases, the first of them entered by `init`. */
const startedByInit = defineMachine({
  types: {
    model: {} as State,
    msg: {} as Msg,
    cmd: {} as Step,
    ctx: undefined,
  },
  init: (loaded) =>
    loaded !== null
      ? [loaded, []]
      : [{ phase: "reading" }, [{ type: "read" as const }]],
  update,
});

/** Handlers the test releases one at a time. */
function heldHandlers() {
  const releases = new Map<Step["type"], () => void>();
  const hold =
    <T extends Msg>(cmd: Step["type"], then: T) =>
    () =>
      new Promise<T>((resolve) => {
        releases.set(cmd, () => resolve(then));
      });
  return {
    interpret: {
      read: hold("read", { type: "read" }),
      think: hold("think", { type: "thought" }),
      write: hold("write", { type: "wrote" }),
    },
    release(cmd: Step["type"]) {
      const release = releases.get(cmd);
      if (release === undefined) throw new Error(`${cmd} is not held`);
      release();
    },
  };
}

const flush = () =>
  act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

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

const stores: Record<string, () => Store<State> | undefined> = {
  "with no store": () => undefined,
  "with a store": () => memoryStore<State>(),
};

describe.each(Object.keys(stores))("useMachine %s", (kind) => {
  function mount(machine: typeof startedByMsg | typeof startedByInit) {
    const handlers = heldHandlers();
    const store = stores[kind]?.();
    let dispatch: ((msg: Msg) => Promise<void>) | undefined;
    function Page() {
      const [state, send] = useMachine(machine, {
        run,
        ctx: undefined,
        store,
        interpret: handlers.interpret,
      });
      dispatch = send;
      return <p>{state.phase}</p>;
    }
    return { Page, handlers, go: () => dispatch?.({ type: "go" }) };
  }

  async function walksThePhases(handlers: ReturnType<typeof heldHandlers>) {
    expect(container.textContent).toBe("reading");
    handlers.release("read");
    await flush();
    expect(container.textContent).toBe("thinking");
    handlers.release("think");
    await flush();
    expect(container.textContent).toBe("writing");
    handlers.release("write");
    await flush();
    expect(container.textContent).toBe("done");
  }

  it("shows each phase while its Cmd is held, when a Msg starts them", async () => {
    const { Page, handlers, go } = mount(startedByMsg);
    await act(async () => {
      root.render(<Page />);
    });
    await flush();
    expect(container.textContent).toBe("idle");

    await act(async () => {
      void go();
    });
    await flush();
    await walksThePhases(handlers);
  });

  it("shows each phase while its Cmd is held, when `init` starts them", async () => {
    const { Page, handlers } = mount(startedByInit);
    await act(async () => {
      root.render(<Page />);
    });
    await flush();
    await walksThePhases(handlers);
  });
});
