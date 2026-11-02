// @vitest-environment happy-dom
/**
 * The React how-to's compile-and-run gate (#542).
 *
 * `docs/how-to/drive-from-react.md` shows five pieces of a component. Each is
 * a `#region` of this file, verbatim (`../page-mirrors.ts` holds the row), so
 * the page shows code the test program compiles. It renders here too, on a
 * real `react-dom/client` root: the machines are the tutorial's downloader and
 * `examples/resilient-fetch.ts`, and each test drives one piece through the
 * hook it names.
 */

// biome-ignore-all assist/source/organizeImports: the `#region` markers below
// pin import blocks the page reproduces verbatim; sorting the harness's imports
// into them would move a marker and break the row this file backs.

import { act, useMemo } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { defineMachine, type Sub, SubFailedError } from "@demlik/tea";
import { memoryStore } from "@demlik/tea/mem";
import { downloader, type State } from "../../../examples/downloader";
import {
  resilientFetch,
  resilientFetchInterpret,
} from "../../../examples/resilient-fetch";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

// #region component
import { run } from "@demlik/tea/promise";
import { useMachine } from "@demlik/tea/react";

function Downloader() {
  const [state, dispatch] = useMachine(downloader, { run, ctx: undefined });

  return (
    <div>
      <p>
        {state.phase}: {state.received}/{state.total}
      </p>
      <button
        type="button"
        onClick={() => dispatch({ type: "start", total: 3 })}
      >
        Start
      </button>
      <button
        type="button"
        onClick={() => dispatch({ type: "chunk", size: 1 })}
      >
        Receive chunk
      </button>
    </div>
  );
}
// #endregion component

function Fetcher() {
  // #region handlers
  const ctx = useMemo(
    () => ({ http: (url: string) => fetch(url).then((r) => r.text()) }),
    [],
  );
  const [state, dispatch] = useMachine(resilientFetch, {
    run,
    ctx,
    interpret: resilientFetchInterpret,
  });
  // #endregion handlers

  return (
    <button
      type="button"
      onClick={() => dispatch({ type: "fetch", url: "/a", at: 0 })}
    >
      {state.phase}: {state.body}
    </button>
  );
}

/** The machine step 2's `subscribe` block watches a job with. */
type JobPoll = Sub<"job_poll", { readonly jobId: string }>;
interface JobState {
  readonly jobId: string | null;
  readonly polls: number;
}
type JobMsg =
  | { readonly type: "watch"; readonly jobId: string }
  | { readonly type: "poll_due"; readonly jobId: string };

const jobWatcher = defineMachine({
  types: { model: {} as JobState, msg: {} as JobMsg, sub: {} as JobPoll },
  init: () => [{ jobId: null, polls: 0 }, []],
  update: {
    watch: (s, m) => [{ ...s, jobId: m.jobId }, []],
    poll_due: (s) => [{ ...s, polls: s.polls + 1 }, []],
  },
  subs: [
    {
      type: "job_poll",
      deps: (s) => (s.jobId === null ? null : { jobId: s.jobId }),
    },
  ],
});

function JobWatcher() {
  const ctx = undefined;
  // #region subscribe
  const [state, dispatch] = useMachine(jobWatcher, {
    run,
    ctx,
    subscribe: {
      job_poll: (sub, _ctx, dispatch) => {
        const timer = setInterval(
          () => dispatch({ type: "poll_due", jobId: sub.deps.jobId }),
          2_000,
        );
        return () => clearInterval(timer);
      },
    },
  });
  // #endregion subscribe

  return (
    <button
      type="button"
      onClick={() => dispatch({ type: "watch", jobId: "j1" })}
    >
      {state.polls}
    </button>
  );
}

const store = memoryStore<State>({
  phase: "downloading",
  received: 2,
  total: 3,
});

function SavedDownloader() {
  // #region store
  const [state, dispatch] = useMachine(downloader, {
    run,
    ctx: undefined,
    store,
  });
  // #endregion store

  return (
    <button type="button" onClick={() => dispatch({ type: "chunk", size: 1 })}>
      {state.phase}
    </button>
  );
}

// #region use-runtime
import { useRuntime } from "@demlik/tea/react";

const runtime = await run(downloader, {
  ctx: undefined,
  terminal: (s) => s.phase === "done",
  onError: (error) => console.error("run error", error),
}).ready;

// A dispatch nobody awaits needs a catch of its own.
function reportFailure(sent: Promise<unknown>) {
  sent.catch((error: unknown) => console.error("dispatch failed", error));
}

function Progress() {
  const [state, dispatch] = useRuntime(runtime);

  return (
    <div>
      <p>
        {state.received}/{state.total}
      </p>
      <button
        type="button"
        onClick={() => reportFailure(dispatch({ type: "chunk", size: 1 }))}
      >
        Receive chunk
      </button>
    </div>
  );
}

// Elsewhere, the owner of the handle waits for the run and stops it.
function finish<S>(owned: { done(): Promise<S>; stop(): Promise<void> }) {
  return owned
    .done()
    .catch((error: unknown) => {
      console.error("run failed", error);
      return undefined;
    })
    .finally(() => owned.stop());
}

const finished = finish(runtime);
// #endregion use-runtime

/** A machine that can reach each way a run ends, for `finish` to meet. */
type Watch = Sub<"watch", { readonly on: true }>;
interface EndingState {
  readonly reached: boolean;
  readonly watching: boolean;
}
type EndingMsg =
  | { readonly type: "reach" }
  | { readonly type: "watch" }
  | { readonly type: "explode" };

const reducerThrew = new Error("reducer threw");
const subFailed = new Error("sub failed");

const ending = defineMachine({
  types: { model: {} as EndingState, msg: {} as EndingMsg, sub: {} as Watch },
  init: () => [{ reached: false, watching: false }, []],
  update: {
    reach: (s) => [{ ...s, reached: true }, []],
    watch: (s) => [{ ...s, watching: true }, []],
    explode: () => {
      throw reducerThrew;
    },
  },
  subs: [
    {
      type: "watch",
      deps: (s) => (s.watching ? { on: true as const } : null),
    },
  ],
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
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const render = (node: React.ReactNode) =>
  act(async () => {
    root.render(node);
  });

const click = (label?: string) =>
  act(async () => {
    const buttons = [...container.querySelectorAll("button")];
    const button =
      label === undefined
        ? buttons[0]
        : buttons.find((b) => b.textContent === label);
    button?.click();
  });

describe("docs/how-to/drive-from-react.md — it renders", () => {
  it("step 1: each dispatch folds a Msg and re-renders", async () => {
    await render(<Downloader />);
    expect(container.querySelector("p")?.textContent).toBe("idle: 0/0");

    await click("Start");
    await click("Receive chunk");
    expect(container.querySelector("p")?.textContent).toBe("downloading: 1/3");
  });

  it("step 2: the hook runs the machine's Cmds through `interpret`, reading `ctx`", async () => {
    vi.stubGlobal(
      "fetch",
      async (url: string) => new Response(`body of ${url}`),
    );
    await render(<Fetcher />);

    await click();
    await vi.waitFor(() =>
      expect(container.textContent).toBe("succeeded: body of /a"),
    );
  });

  it("step 2: the hook starts the machine's own Sub through `subscribe`", async () => {
    vi.useFakeTimers();
    await render(<JobWatcher />);

    await click();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(4_000);
    });
    expect(container.textContent).toBe("2");
  });

  it("step 3: a `store` boots the component from the saved Model", async () => {
    await render(<SavedDownloader />);
    await vi.waitFor(() => expect(container.textContent).toBe("downloading"));

    await click();
    expect(container.textContent).toBe("done");
    expect(store.migrate(await store.load())).toMatchObject({ phase: "done" });
  });

  it("`useRuntime` renders a handle the component does not own", async () => {
    await render(<Progress />);
    expect(container.querySelector("p")?.textContent).toBe("0/0");

    await act(async () => {
      await runtime.dispatch({ type: "start", total: 1 });
    });
    await click("Receive chunk");
    expect(container.querySelector("p")?.textContent).toBe("1/1");
    expect((await finished)?.phase).toBe("done");
  });
});

describe("docs/how-to/drive-from-react.md — `finish` and `reportFailure` in a host with an `onError`", () => {
  const unhandled: unknown[] = [];
  const hearUnhandled = (reason: unknown) => {
    unhandled.push(reason);
  };

  beforeEach(() => {
    unhandled.length = 0;
    process.on("unhandledRejection", hearUnhandled);
  });

  afterEach(() => {
    process.off("unhandledRejection", hearUnhandled);
    vi.restoreAllMocks();
  });

  /**
   * Does what the page tells a host to do: starts `finish`, dispatches through
   * `reportFailure`, and awaits neither, until Node has had its chance to call a
   * rejection unhandled.
   *
   * `stop` counts `finish`'s call alone. A Sub failure and a reducer throw also
   * make the engine stop the handle itself, and that call does not go through
   * here.
   */
  async function endRun(msg: EndingMsg) {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    const heard: unknown[] = [];
    const owned = await run(ending, {
      ctx: undefined,
      terminal: (s) => s.reached,
      onError: (error) => heard.push(error),
      subscribe: {
        watch: () => {
          throw subFailed;
        },
      },
    }).ready;
    const stop = vi.fn(() => owned.stop());

    const unawaited = finish({ done: () => owned.done(), stop });
    reportFailure(owned.dispatch(msg));
    await vi.waitFor(() => expect(stop).toHaveBeenCalledOnce());
    await new Promise((settled) => setTimeout(settled, 0));

    expect(unhandled).toEqual([]);
    return { answer: await unawaited, logged, heard };
  }

  it("a terminal State: `stop()` ran and `finished` holds the State", async () => {
    const { answer, logged, heard } = await endRun({ type: "reach" });

    expect(answer?.reached).toBe(true);
    expect(logged).not.toHaveBeenCalled();
    expect(heard).toEqual([]);
  });

  it("a Sub failure: `stop()` ran and the host hears a `SubFailedError` from `done()` and the Sub's throw from `dispatch`", async () => {
    const { answer, logged, heard } = await endRun({ type: "watch" });

    expect(answer).toBeUndefined();
    const [, error] =
      logged.mock.calls.find(([label]) => label === "run failed") ?? [];
    expect(error).toBeInstanceOf(SubFailedError);
    expect((error as SubFailedError).cause).toBe(subFailed);
    expect(logged).toHaveBeenCalledWith("dispatch failed", subFailed);
    expect(heard).toContain(subFailed);
  });

  it("a reducer throw: `stop()` ran and the host hears what was thrown, from `done()` and from `dispatch`", async () => {
    const { answer, logged, heard } = await endRun({ type: "explode" });

    expect(answer).toBeUndefined();
    expect(logged).toHaveBeenCalledWith("run failed", reducerThrew);
    expect(logged).toHaveBeenCalledWith("dispatch failed", reducerThrew);
    expect(heard).toContain(reducerThrew);
  });
});
