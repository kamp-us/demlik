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
import { defineMachine, type Sub } from "@demlik/tea";
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
}).ready;

function Progress() {
  const [state] = useRuntime(runtime);

  return (
    <p>
      {state.received}/{state.total}
    </p>
  );
}

// Elsewhere, the owner of the handle awaits the run and stops it.
const finished = runtime.done().finally(() => runtime.stop());
// #endregion use-runtime

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
    expect(container.textContent).toBe("0/0");

    await act(async () => {
      await runtime.dispatch({ type: "start", total: 1 });
      await runtime.dispatch({ type: "chunk", size: 1 });
    });
    expect(container.textContent).toBe("1/1");
    expect((await finished).phase).toBe("done");
  });
});
