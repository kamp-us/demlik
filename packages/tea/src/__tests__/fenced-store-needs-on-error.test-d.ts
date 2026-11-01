// Type-level test for ADR 0031 (#728). Compiled by `pnpm typecheck`. Each
// `@ts-expect-error` MUST sit on a line that genuinely fails to type-check; every
// line without one is a positive case.
//
// The contract: a run on a fenced store must be given an `onError`, on every way
// of starting one. An unfenced store, or no store, still leaves it optional.

import { z } from "zod";
import type { AgentMachineMsg, AgentState, AgentTurn } from "../agent/index";
import {
  agentTool,
  type DefinedAgent,
  type DefinedAgentState,
} from "../agent/index";
import { type AgentHostConfig, createAgentHost } from "../do/host";
import { run as runEffect } from "../effect/index";
import {
  type Cmd,
  defineMachine,
  type EngineRun,
  type FencedStore,
  type Machine,
  type OnError,
  type RunOptions,
  type Store,
  type Sub,
} from "../index";
import { memoryStore } from "../mem";
import { fileStore } from "../node";
import { run } from "../promise";
import { useMachine } from "../react/index";

type State = { readonly count: number };
type Msg = { readonly type: "bump" };

const machine = defineMachine({
  types: { model: {} as State, msg: {} as Msg, ctx: undefined },
  init: (loaded) => [loaded ?? { count: 0 }, []],
  update: { bump: (state) => [{ count: state.count + 1 }, []] },
});

declare const fenced: FencedStore<State>;
declare const plain: Store<State>;
declare const onError: OnError;
declare const parse: (raw: unknown) => State | null;

// ── The Promise engine ───────────────────────────────────────────────────────

run(machine, { ctx: undefined });
run(machine, { ctx: undefined, onError });
run(machine, { ctx: undefined, store: plain });
run(machine, { ctx: undefined, store: plain, onError });
run(machine, { ctx: undefined, store: fileStore("f", parse) });
run(machine, { ctx: undefined, store: memoryStore<State>() });
run(machine, { ctx: undefined, store: fenced, onError });
run(machine, {
  ctx: undefined,
  store: fileStore("f", parse, { fenced: true }),
  onError,
});

// @ts-expect-error a fenced store with no `onError`
run(machine, { ctx: undefined, store: fenced });
// @ts-expect-error `onError: undefined` is no sink either
run(machine, { ctx: undefined, store: fenced, onError: undefined });
// @ts-expect-error each shipped fenced factory is held to it
run(machine, {
  ctx: undefined,
  store: fileStore("f", parse, { fenced: true }),
});
// @ts-expect-error
run(machine, {
  ctx: undefined,
  store: memoryStore<State>(null, undefined, { fenced: true }),
});

// A store whose fencing is only known at runtime could be either, so it needs one.
declare const maybeFenced: { readonly fenced?: true };
run(machine, {
  ctx: undefined,
  store: fileStore("f", parse, maybeFenced),
  onError,
});
// @ts-expect-error
run(machine, {
  ctx: undefined,
  store: fileStore("f", parse, maybeFenced),
});

// The limit ADR 0031 names: assigned to a plain `Store`, the type no longer says
// it is fenced.
const widened: Store<State> = fenced;
run(machine, { ctx: undefined, store: widened });

// ── The Effect engine ────────────────────────────────────────────────────────

runEffect(machine, { ctx: undefined, store: fenced, onError });
runEffect(machine, { ctx: undefined, store: plain });
runEffect(machine, { ctx: undefined });
// @ts-expect-error a fenced store with no `onError`
runEffect(machine, { ctx: undefined, store: fenced });

// ── A host adapter's view of an engine ───────────────────────────────────────

export const promiseFits: EngineRun<
  State,
  Msg,
  never,
  Sub<never>,
  undefined
> = run;
export const withSink: RunOptions<State, Msg, never, Sub<never>, undefined> = {
  ctx: undefined,
  store: fenced,
  onError,
};
// @ts-expect-error a fenced store with no `onError`
export const noSink: RunOptions<State, Msg, never, Sub<never>, undefined> = {
  ctx: undefined,
  store: fenced,
};

// ── useMachine ───────────────────────────────────────────────────────────────

export function Component() {
  useMachine(machine, { run, ctx: undefined, store: plain });
  useMachine(machine, { run, ctx: undefined, store: fenced, onError });
  // @ts-expect-error a fenced store with no `onError`
  useMachine(machine, { run, ctx: undefined, store: fenced });
}

// ── createAgentHost ──────────────────────────────────────────────────────────

type HostStage = "scan";
type HostPurpose = "plan";
type HostOutputs = Record<HostPurpose, AgentTurn>;
type HostState = AgentState<HostStage, HostPurpose, HostOutputs, unknown>;
type HostMsg = AgentMachineMsg<HostPurpose, HostOutputs, unknown>;
type HostConfig = AgentHostConfig<
  HostStage,
  HostPurpose,
  HostOutputs,
  unknown,
  never
>;

declare const hostRun: HostConfig["run"];
declare const hostMachine: Machine<HostState, HostMsg, Cmd, Sub, unknown>;
declare const hostFenced: FencedStore<HostState>;
declare const hostPlain: Store<HostState>;
const hostWiring = {
  run: hostRun,
  buildMachine: () => ({ machine: hostMachine }),
  ctx: undefined,
  toSseFrame: () => null,
} as unknown as Pick<HostConfig, "run" | "buildMachine" | "ctx" | "toSseFrame">;

createAgentHost({ ...hostWiring, store: hostPlain });
createAgentHost({ ...hostWiring, store: hostFenced, onError });
// @ts-expect-error a fenced store with no `onError`
createAgentHost({ ...hostWiring, store: hostFenced });
// @ts-expect-error the host still needs a store
createAgentHost({ ...hostWiring, onError });

// ── defineAgent's `run` and agentTool ────────────────────────────────────────

type NoTools = never;
declare const agent: DefinedAgent<NoTools>;
declare const agentFenced: FencedStore<DefinedAgentState<NoTools>>;
declare const agentPlain: Store<DefinedAgentState<NoTools>>;

agent.run("go");
agent.run("go", { store: agentPlain });
agent.run("go", { store: agentFenced, onError });
// @ts-expect-error a fenced store with no `onError`
agent.run("go", { store: agentFenced });

const toolSpec = {
  description: "",
  input: z.object({}),
  ok: z.object({}),
  agent,
  prompt: () => "",
  result: () => ({}),
  namespace: () => "",
};
agentTool("plain", { ...toolSpec, store: () => agentPlain });
agentTool("fenced", { ...toolSpec, store: () => agentFenced, onError });
// @ts-expect-error a fenced child store with no `onError`
agentTool("refused", { ...toolSpec, store: () => agentFenced });
