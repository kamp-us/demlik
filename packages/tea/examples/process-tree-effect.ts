import { Cmd, defineMachine } from "@demlik/tea";
import { type EffectRuntime, run, spawn, stop, tell } from "@demlik/tea/effect";
import { Context, Effect, Layer, type Scope } from "effect";
import { z } from "zod";
import { type ParentMsg, type ParentState, parent } from "./parent-and-workers";

/** Write one line to the process's terminal. */
export const writeLine = Cmd.define("write_line", {
  input: z.object({ text: z.string() }),
  ok: z.object({}),
  err: ["closed"],
});

/** A child: counts the lines it wrote. */
export interface ProcessState {
  readonly written: number;
}

export type ProcessMsg = { readonly type: "input"; readonly text: string };

export const proc = defineMachine({
  types: { model: {} as ProcessState, msg: {} as ProcessMsg },
  cmds: [writeLine],
  init: (loaded) => [loaded ?? { written: 0 }, []],
  update: {
    input: (s, m) => [s, [writeLine({ text: m.text })]],
    write_line_ok: (s) => [{ written: s.written + 1 }, []],
    write_line_err: (s) => [s, []],
  },
});

/** One process's terminal. Every process gets its own. */
export class Terminal extends Context.Service<
  Terminal,
  {
    readonly write: (text: string) => Effect.Effect<void, { _tag: "closed" }>;
  }
>()("Terminal") {}

/** Boot one process. Needs a Scope and that process's Terminal. */
export const runProcess = run(proc, {
  interpret: {
    write_line: (cmd) =>
      Effect.gen(function* () {
        const terminal = yield* Terminal;
        yield* terminal.write(cmd.text);
        return {};
      }),
  },
});

/**
 * A child in the host's table. It is `starting` from the moment its scope is
 * forked until its run is up, so a lookup can tell the two apart.
 */
export type Process =
  | { readonly lifecycle: "starting" }
  | {
      readonly lifecycle: "running";
      readonly run: Effect.Success<typeof runProcess>;
      readonly scope: Scope.Closeable;
    };

/** The host's own table of processes, by id. tea keeps none. */
export type Processes = Map<string, Process>;

/**
 * Start a process under the parent with its own `terminal`. The host's work
 * between the fork and the run is in `start`: it marks the process
 * `starting`, then builds the process's services in the child's scope. A
 * build that fails or is interrupted closes that scope, which removes the
 * entry and tells the parent.
 */
export const spawnProcess = <E>(
  parentScope: Scope.Scope,
  parentRun: EffectRuntime<ParentState, ParentMsg>,
  processes: Processes,
  id: string,
  terminal: Layer.Layer<Terminal, E>,
): Effect.Effect<Process, E> =>
  spawn(parentScope, {
    start: (scope) =>
      Effect.gen(function* () {
        processes.set(id, { lifecycle: "starting" });
        const services = yield* Layer.build(terminal);
        const run = yield* Effect.provide(runProcess, services);
        return { lifecycle: "running", run, scope } satisfies Process;
      }),
    enrol: (process) => Effect.sync(() => processes.set(id, process)),
    remove: Effect.sync(() => processes.delete(id)),
    notify: tell(parent, parentRun, { type: "child_stopped", id }),
  });

/** Stop one running process. Any other id is a no-op. */
export const stopProcess = (
  processes: Processes,
  id: string,
): Effect.Effect<void> =>
  Effect.suspend(() => {
    const process = processes.get(id);
    return process?.lifecycle === "running" ? stop(process.scope) : Effect.void;
  });
