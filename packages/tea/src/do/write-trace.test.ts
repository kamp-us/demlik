/**
 * `writeTrace` into the recording store: a captured drive written afterwards
 * leaves the cells a live run on that store would have written.
 */

import { describe, expect, it } from "vitest";
import { fakeDoStorage as fakeStorage } from "../__fixtures__/do-storage";
import { DriveStalledError, defineMachine, type Transitions } from "../index";
import { recorder, writeTrace } from "../persistence";
import { driveToDone, run } from "../promise";
import { doEventSourcedStore } from "./index";

interface Model {
  readonly _tag: "counting";
  readonly count: number;
  readonly items: readonly string[];
}
type Msg = { _tag: "inc"; by: number };
type Cmd = { _tag: "notify"; count: number };

const fresh: Model = {
  _tag: "counting",
  count: 0,
  items: Array.from({ length: 40 }, (_, at) => `item-${at}`),
};

const update: Transitions<Model, Msg, Cmd> = {
  counting: {
    inc: (s, m) => [
      { ...s, count: s.count + m.by },
      [{ _tag: "notify", count: s.count + m.by }],
    ],
  },
};

const counter = defineMachine({
  types: { model: {} as Model, msg: {} as Msg, cmd: {} as Cmd },
  init: (loaded) => [loaded ?? fresh, []],
  update,
});

const ctx = {};
const recording = { recording: { provenance: { run: "r" } } };
const storeOver = (backing: Map<string, string>, withEvidence: boolean) =>
  doEventSourcedStore(
    fakeStorage(backing).storage,
    counter,
    ctx,
    withEvidence ? recording : {},
  ).store;

/** A drive of three Msgs, recorded in memory, and the cells a live run on a recording store wrote. */
async function drive() {
  const live = new Map<string, string>();
  const handle = run(counter, {
    store: storeOver(live, true),
    onError: () => {},
    interpret: { notify: async () => {} },
  });
  const capture = recorder(handle, { captureSteps: true });
  const rt = await handle.ready;
  for (const by of [1, 2, 3]) await rt.dispatch({ _tag: "inc", by });
  await rt.stop();
  return { live, trace: capture.dump() };
}

describe("writeTrace", () => {
  it("leaves the cells a live run on a recording store wrote", async () => {
    const { live, trace } = await drive();
    const written = new Map<string, string>();

    await writeTrace(storeOver(written, true), trace);

    expect([...written.keys()]).toHaveLength(5);
    expect(written).toEqual(live);
  });

  it("leaves only the Msgs on a store that does not record", async () => {
    const { trace } = await drive();
    const written = new Map<string, string>();

    await writeTrace(storeOver(written, false), trace);

    expect(
      [...written]
        .filter(([key]) => key.startsWith("@@es/evt/"))
        .map(([, cell]) => JSON.parse(cell)),
    ).toEqual([
      { _tag: "inc", by: 1 },
      { _tag: "inc", by: 2 },
      { _tag: "inc", by: 3 },
    ]);
  });

  it("saves nothing for a trace it refuses", async () => {
    const { trace } = await drive();
    const written = new Map<string, string>();

    await expect(
      writeTrace(storeOver(written, true), { ...trace, steps: undefined }),
    ).rejects.toThrow(/captureSteps/);
    expect(written.size).toBe(0);
  });
});

describe("keeping only a failed drive's recording", () => {
  /** The shape the how-to shows: the trace write has its own `try`, and the drive's error is rethrown. */
  async function driveKeepingFailure(
    store: Parameters<typeof writeTrace<Model, Msg>>[0],
    diagnostics: unknown[],
  ) {
    const handle = run(counter, {
      onError: () => {},
      interpret: { notify: async () => {} },
    });
    const capture = recorder(handle, { captureSteps: true });
    try {
      return await driveToDone(handle, { _tag: "inc", by: 1 }, () => false);
    } catch (error) {
      try {
        await writeTrace(store, capture.dump());
      } catch (diagnostic) {
        diagnostics.push(diagnostic);
      }
      throw error;
    } finally {
      capture.stop();
    }
  }

  it("writes the recording of a drive that fails, and rethrows the drive's error", async () => {
    const written = new Map<string, string>();
    const diagnostics: unknown[] = [];

    await expect(
      driveKeepingFailure(storeOver(written, true), diagnostics),
    ).rejects.toBeInstanceOf(DriveStalledError);

    expect(diagnostics).toEqual([]);
    expect(
      [...written.keys()].filter((key) => key.startsWith("@@es/evt/")),
    ).toHaveLength(2);
  });

  it("rethrows the drive's error, not the store's, when the store cannot load", async () => {
    const unavailable = new Error("storage is down");
    const diagnostics: unknown[] = [];

    const failure = await driveKeepingFailure(
      {
        load: async () => {
          throw unavailable;
        },
        save: async () => {},
      },
      diagnostics,
    ).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(DriveStalledError);
    expect(diagnostics).toEqual([unavailable]);
  });
});
