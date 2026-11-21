import { z } from "zod";
import {
  type DefinedAgentMsg,
  type DefinedAgentState,
  defineAgent,
  tool,
} from "../agent/index";
import type { Store, Wired } from "../index";
import { run } from "../promise";
import { createAgentHost } from "./index";

const echo = tool(
  "echo",
  { description: "Echo", input: z.string(), ok: z.string(), err: [] },
  async (input, _ctx: object, settle) => settle.ok(input),
);
const wired = defineAgent({
  instructions: "",
  tools: [echo],
  model: async () => ({ content: "", toolCalls: [] }),
}).machine("repro");
declare const store: Store<DefinedAgentState<typeof echo>>;
const host = createAgentHost({
  buildMachine: () => wired,
  ctx: {},
  run,
  store,
  toSseFrame: () => null,
  onError: () => {},
});
// The booted handle preserves the tool's settle messages too.
declare const settled: Extract<
  DefinedAgentMsg<typeof echo>,
  { _tag: "echo_ok" }
>;
host.runtime().then((runtime) => {
  runtime.dispatch(settled);
  // @ts-expect-error The inferred union does not accept arbitrary messages.
  runtime.dispatch({ _tag: "unrelated" });
});

const empty = defineAgent({
  instructions: "",
  tools: [],
  model: async () => ({ content: "", toolCalls: [] }),
}).machine("control");
declare const emptyStore: Store<DefinedAgentState<never>>;
createAgentHost({
  buildMachine: () => empty,
  ctx: {},
  run,
  store: emptyStore,
  toSseFrame: () => null,
  onError: () => {},
});

declare const nonAgent: Wired<
  DefinedAgentState<typeof echo>,
  { readonly _tag: "unrelated" },
  never,
  never,
  object
>;
createAgentHost({
  // @ts-expect-error A host machine must accept the agent messages.
  buildMachine: () => nonAgent,
  ctx: {},
  run,
  store,
  toSseFrame: () => null,
  onError: () => {},
});
