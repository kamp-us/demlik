import { defineMachine, type Reducer } from "../../packages/tea/src/index";
import { run } from "../../packages/tea/src/promise";

type Model = { type: "state"; count: number };
type Msg = { type: "inc" };
const update: Reducer<Model, Msg, never> = {
  inc: (state) => [{ type: "state", count: state.count + 1 }, []],
};
const machine = defineMachine({
  init: (loaded: Model | null): readonly [Model, readonly never[]] => [
    loaded ?? { type: "state", count: 0 },
    [],
  ],
  update,
});
const runtime = await run(machine, { subscribe: {} }).ready;
await runtime.dispatch({ type: "inc" });
const count = runtime.getState().count;
await runtime.stop();
console.log(JSON.stringify({ count }));
