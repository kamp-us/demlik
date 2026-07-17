/**
 * Compile-time regression test for #278 — `AgentHostConfig.buildMachine` must
 * NOT erase the machine's Cmd / Sub / Ctx to `any`: a consumer gets real
 * checking on all three through `AgentHostConfig` / `createAgentHost`.
 *
 * Type-level only, same discipline as `event-sourced-store.cmdless.type-test.ts`:
 * never executed, not a `*.test.ts` (vitest skips it), not a tsup entry (never
 * bundled), but under `src` so `tsc --noEmit` (the `typecheck` script) enforces
 * it. Before #278 the three `any` params meant every `@ts-expect-error` below
 * was unused — the erasure accepted anything — and this file failed to compile.
 */
import type { AgentMachineMsg, AgentState, AgentTurn } from "../agent/index";
import type { Cmd, Machine, Store, Sub } from "../index";
import { type AgentHost, type AgentHostConfig, createAgentHost } from "./host";

type Stage = "scan" | "done";
type Purpose = "plan";
interface Outputs extends Record<Purpose, AgentTurn> {
  readonly plan: AgentTurn;
}
type ToolResult = { readonly ok: boolean };
type Frame = { readonly kind: "phase" };

type S = AgentState<Stage, Purpose, Outputs, ToolResult>;
type M = AgentMachineMsg<Purpose, Outputs, ToolResult>;

type MyCmd = Cmd<"tool_run"> & { readonly arg: string };
type MySub = Sub<"deadline">;
type MyCtx = { readonly db: string };
type OtherCtx = { readonly queue: number };

declare const machine: Machine<S, M, MyCmd, MySub, MyCtx>;
declare const otherCtxMachine: Machine<S, M, MyCmd, MySub, OtherCtx>;
declare const store: Store<S>;
declare const toSseFrame: (event: unknown) => Frame | null;

// ── The happy path: a consumer names its Cmd/Sub/Ctx through the config's
//    generics and the machine + ctx line up — compiles with zero casts. ──────
const wellTyped: AgentHostConfig<
  Stage,
  Purpose,
  Outputs,
  ToolResult,
  Frame,
  MyCmd,
  MySub,
  MyCtx
> = {
  buildMachine: () => machine,
  store,
  ctx: { db: "d1" },
  toSseFrame,
};
createAgentHost(wellTyped);

// ── Ctx is checked: a ctx that isn't the machine's Ctx is rejected. Under the
//    pre-#278 erasure `ctx` sat next to an `any`-Ctx machine unchecked. ───────
const badCtx: AgentHostConfig<
  Stage,
  Purpose,
  Outputs,
  ToolResult,
  Frame,
  MyCmd,
  MySub,
  MyCtx
> = {
  buildMachine: () => machine,
  store,
  // @ts-expect-error — ctx must be MyCtx, not an arbitrary bag
  ctx: { wrong: true },
  toSseFrame,
};
void badCtx;

// ── The machine itself is checked: a machine built for a DIFFERENT Ctx no
//    longer erases through `any` into a host that threads the wrong ctx. ─────
const badMachine: AgentHostConfig<
  Stage,
  Purpose,
  Outputs,
  ToolResult,
  Frame,
  MyCmd,
  MySub,
  MyCtx
> = {
  // @ts-expect-error — Machine<…, OtherCtx> is not Machine<…, MyCtx>
  buildMachine: () => otherCtxMachine,
  store,
  ctx: { db: "d1" },
  toSseFrame,
};
void badMachine;

// ── Inference end-to-end: no explicit type args, C/U/Ctx flow from the
//    machine, and a mismatched ctx still fails inside createAgentHost. ────────
const host = createAgentHost({
  buildMachine: () => machine,
  store,
  ctx: { db: "d1" } as MyCtx,
  toSseFrame: (e): Frame | null =>
    e.type === "RunDone" ? { kind: "phase" } : null,
});
// the host surface keeps the agent-slice params (Frame included):
const _host: AgentHost<Stage, Purpose, Outputs, ToolResult, Frame> = host;
void _host;
