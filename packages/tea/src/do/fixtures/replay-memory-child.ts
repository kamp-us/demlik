import { fakeDoStorage } from "../../__fixtures__/do-storage";
import { defineMachine, foldMsgs } from "../../index";
import { doEventSourcedStore } from "../event-sourced-store";

type State = { readonly count: number };
type Msg = { readonly _tag: "advance" };
type Command = { readonly _tag: "send"; readonly history: readonly number[] };

const machine = defineMachine({
  types: { model: {} as State, msg: {} as Msg, cmd: {} as Command },
  init: (loaded) => [loaded ?? { count: 0 }, []],
  update: {
    advance: (state) => [
      { count: state.count + 1 },
      [
        {
          _tag: "send",
          history: Array.from({ length: state.count * 200 }, (_, i) => i),
        },
      ],
    ],
  },
});
const msgs: Msg[] = Array.from({ length: 600 }, () => ({ _tag: "advance" }));
const counts = [foldMsgs(machine, { count: 0 }, msgs).count];
for (const snapshot of [false, true]) {
  const backing = new Map<string, string>(
    msgs.map((msg, i) => [
      `@@es/evt/${String(i + 1).padStart(16, "0")}`,
      JSON.stringify(msg),
    ]),
  );
  backing.set("@@es/meta", '{"lastSeq":600}');
  if (snapshot) backing.set("@@es/snapshot", '{"seq":1,"state":{"count":1}}');
  const es = doEventSourcedStore(fakeDoStorage(backing).storage, machine, {});
  const state = es.store.migrate(await es.store.load());
  if (state === null || !("count" in state)) throw new Error("restore refused");
  counts.push(state.count);
}
process.stdout.write(counts.join(","));
