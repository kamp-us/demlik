import { fakeDoStorage } from "../../__fixtures__/do-storage";
import { defineMachine, type Transitions } from "../../index";
import { recorder, writeTrace } from "../../persistence";
import { run } from "../../promise";
import { doEventSourcedStore, type EventSourcedOptions } from "../index";

interface Model {
  readonly _tag: "counting";
  readonly count: number;
  readonly items: readonly string[];
}
type Msg = { _tag: "inc"; by: number } | { _tag: "reset" };
type Cmd = { _tag: "notify"; count: number } | { _tag: "hello" };

const update: Transitions<Model, Msg, Cmd> = {
  counting: {
    inc: (s, m) => [
      {
        ...s,
        count: s.count + m.by,
        items: [...s.items.slice(1), `item-${s.count + m.by}`],
      },
      [{ _tag: "notify", count: s.count + m.by }],
    ],
    reset: (s) => [{ ...s, count: 0 }, []],
  },
};

const counter = defineMachine({
  types: { model: {} as Model, msg: {} as Msg, cmd: {} as Cmd },
  init: (loaded) => [
    loaded ?? {
      _tag: "counting",
      count: 0,
      items: Array.from({ length: 30 }, (_, at) => `item-${at}`),
    },
    [{ _tag: "hello" }],
  ],
  update,
});

type Options = EventSourcedOptions<Model, Msg>;

const msgsFor = (count: number, from: number): Msg[] =>
  Array.from({ length: count }, (_, at) =>
    (from + at) % 11 === 10
      ? { _tag: "reset" }
      : { _tag: "inc", by: from + at },
  );

async function liveRun(
  backing: Map<string, string>,
  msgs: readonly Msg[],
  opts: Options,
) {
  const es = doEventSourcedStore(
    fakeDoStorage(backing).storage,
    counter,
    {},
    opts,
  );
  const handle = run(counter, {
    store: es.store,
    onError: () => {},
    interpret: { notify: async () => {}, hello: async () => {} },
  });
  const capture = recorder(handle, { captureSteps: true });
  const rt = await handle.ready;
  for (const msg of msgs) await rt.dispatch(msg);
  await rt.stop();
  capture.stop();
  return capture.dump();
}

/**
 * The cells a set of event-sourced logs end with, sorted by key, written with
 * no moved anchor and no row budget: live runs on a recording and a message
 * log, across a restart and past `snapshotEvery`, and `writeTrace` of an
 * unwindowed trace into each. `recording-bytes.main.json` holds what the
 * release before row budgets wrote for the same calls.
 */
export async function recordingBytesScenario(): Promise<
  Record<string, [string, string][]>
> {
  const recording: Options = {
    snapshotEvery: 7,
    recording: { provenance: { run: "fixture" } },
  };
  const messages: Options = { snapshotEvery: 7 };
  const out: Record<string, Map<string, string>> = {};

  out.liveRecording = new Map();
  await liveRun(out.liveRecording, msgsFor(40, 0), recording);
  await liveRun(out.liveRecording, msgsFor(9, 40), recording);

  out.liveMessages = new Map();
  await liveRun(out.liveMessages, msgsFor(20, 0), messages);
  await liveRun(out.liveMessages, msgsFor(5, 20), messages);

  const trace = await liveRun(new Map(), msgsFor(25, 0), {});
  out.traceRecording = new Map();
  await writeTrace(
    doEventSourcedStore(
      fakeDoStorage(out.traceRecording).storage,
      counter,
      {},
      recording,
    ).store,
    trace,
  );
  out.traceMessages = new Map();
  await writeTrace(
    doEventSourcedStore(
      fakeDoStorage(out.traceMessages).storage,
      counter,
      {},
      messages,
    ).store,
    trace,
  );

  return Object.fromEntries(
    Object.entries(out).map(([name, cells]) => [
      name,
      [...cells].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
    ]),
  );
}
