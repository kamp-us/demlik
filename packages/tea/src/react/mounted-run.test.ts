import { describe, expect, it, vi } from "vitest";
import { defineMachine } from "../index";
import { run } from "../promise";
import { MountedRun } from "./mounted-run";

// React's own calls are in `strict-activity.test.tsx`. This pins the one order
// React does not make today: an insertion cleanup on a hide. `useMachine` relies
// on React's observed behaviour there, not a promise, so a later React that did
// it must leave a working component, not a dead one.

const machine = defineMachine({
  types: {
    model: {} as { readonly n: number },
    msg: {} as { readonly type: "inc" },
    ctx: undefined,
  },
  init: () => [{ n: 0 }, []],
  update: { inc: (s) => [{ n: s.n + 1 }, []] },
});

function mountedRun(cleanupMayBeAHide = true) {
  const startRun = vi.fn(() => run(machine, { ctx: undefined }));
  return {
    startRun,
    mounted: new MountedRun(startRun, { n: 0 }, cleanupMayBeAHide),
  };
}

const microtask = () => new Promise<void>((resolve) => queueMicrotask(resolve));

describe("MountedRun, if React ever retired it on a hide", () => {
  it("takes the same run back when the show comes before the cleanup acts", async () => {
    const { startRun, mounted } = mountedRun();
    mounted.connect();

    mounted.retire();
    mounted.disconnect();
    mounted.connect();
    await microtask();

    await mounted.dispatch({ type: "inc" });
    expect(mounted.getSnapshot()).toEqual({ n: 1 });
    expect(startRun).toHaveBeenCalledTimes(1);
  });

  it("starts a new run when the show comes after the run stopped", async () => {
    const { startRun, mounted } = mountedRun();
    mounted.connect();

    mounted.retire();
    mounted.disconnect();
    await microtask();
    await expect(mounted.dispatch({ type: "inc" })).rejects.toThrow(
      "@demlik/tea: runtime stopped",
    );

    mounted.connect();
    await mounted.dispatch({ type: "inc" });
    expect(startRun).toHaveBeenCalledTimes(2);
  });
});

// `peer-range.test.tsx` runs this order on the real Reacts.
describe("MountedRun, on a React where a cleanup cannot be a hide", () => {
  it("stops the run on a cleanup with nothing after it, with no insertion cleanup", async () => {
    const { mounted } = mountedRun(false);
    mounted.connect();

    mounted.disconnect();
    await microtask();

    await expect(mounted.dispatch({ type: "inc" })).rejects.toThrow(
      "@demlik/tea: runtime stopped",
    );
  });

  it("stays live through Strict Mode's cleanup and effect in one pass", async () => {
    const { startRun, mounted } = mountedRun(false);
    mounted.connect();

    mounted.disconnect();
    mounted.connect();
    await microtask();

    await mounted.dispatch({ type: "inc" });
    expect(mounted.getSnapshot()).toEqual({ n: 1 });
    expect(startRun).toHaveBeenCalledTimes(1);
  });
});
