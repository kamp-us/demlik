import { applyCell, type Machine, type Reducer } from "@demlik/tea";
import {
  type AgentTurn,
  agentTurnSchema,
  compactionSummarySchema,
  createAgent,
  type Schema,
  type ToolCall,
} from "@demlik/tea/agent";
import {
  type Evidence,
  evidenceSchema,
  type Msg,
  requestSchema,
  type Search,
  searchArgsSchema,
} from "./source";

export interface Ports {
  readonly model: (turn: number) => Promise<unknown>;
  readonly search: (turn: number) => Promise<unknown>;
  readonly summarize: (payload: unknown) => Promise<unknown>;
  readonly now: () => number;
}

export const MAX_MODEL_TURNS = 32;

export function investigation(ports: Ports) {
  const agent = createAgent<
    "investigate",
    "investigate",
    { investigate: AgentTurn },
    Evidence,
    Search,
    { readonly turn: number }
  >({
    stages: ["investigate"],
    model: () => ({
      withStructuredOutput<T>(schema: Schema<T>) {
        return {
          invoke: async (messages: readonly { readonly turn: number }[]) => {
            const request = requestSchema.parse(messages[0]);
            try {
              return schema.parse(await ports.model(request.turn));
            } catch (error) {
              throw reason(error);
            }
          },
        };
      },
    }),
    schemas: { investigate: agentTurnSchema },
    turnOf: () => "investigate",
    payloadOf: (_stage, conversation) => ({ turn: conversation.turnCount }),
    loadMessages: async (call) => [requestSchema.parse(call.payload)],
    toolOf: (call: ToolCall): Search => ({ type: "search", ...call }),
    maxTurns: MAX_MODEL_TURNS,
    rng: () => 0,
    compaction: {
      planCompaction: (conversation) =>
        conversation.turns.length >= 6 ? 5 : 0,
      payloadOf: (conversation, folding) => ({
        turns: conversation.turns.slice(0, folding),
      }),
    },
  });

  const wired = agent.toMachine<Ports>({
    toolInterpret: {
      search: async (cmd, ctx) => {
        try {
          const { turn } = searchArgsSchema.parse(cmd.args);
          const result = evidenceSchema.parse(await ctx.search(turn));
          return {
            type: "agent_tool_ok",
            callId: cmd.callId,
            result,
            at: ctx.now(),
          };
        } catch (error) {
          return {
            type: "agent_tool_err",
            callId: cmd.callId,
            reason: reason(error),
            at: ctx.now(),
          };
        }
      },
      compact_run: async (cmd, ctx) => {
        try {
          const output = compactionSummarySchema.parse(
            await ctx.summarize(cmd.input.payload),
          );
          return {
            type: "compact_ok",
            key: cmd.key,
            result: { key: cmd.key, purpose: cmd.key, output },
            at: ctx.now(),
          };
        } catch (error) {
          const text = reason(error);
          return {
            type: "compact_err",
            key: cmd.key,
            error: {
              key: cmd.key,
              purpose: cmd.key,
              reason: text,
              error: text,
            },
            at: ctx.now(),
          };
        }
      },
    },
  });

  type Model = ReturnType<typeof agent.init>;
  type Cmd =
    | Parameters<typeof wired.interpret.search>[0]
    | Parameters<typeof wired.interpret.compact_run>[0]
    | Parameters<typeof wired.interpret.resilient_run>[0];
  type Sub = Parameters<typeof wired.subscribe.deadline>[0];
  type State = {
    readonly agent: Model;
    readonly msg: Msg | null;
    readonly revision: number;
  };
  const step = (state: State, msg: Msg): readonly [State, readonly Cmd[]] => {
    const [next, cmds] = applyCell<Model, Msg, Cmd>(
      wired.machine,
      state.agent,
      msg,
    );
    return [{ agent: next, msg, revision: state.revision + 1 }, cmds];
  };
  const update: Reducer<State, Msg, Cmd> = {
    agent_start: step,
    agent_boot: step,
    agent_cancel: step,
    agent_tool_ok: step,
    agent_tool_err: step,
    resilient_run_ok: step,
    resilient_run_err: step,
    compact_ok: step,
    compact_err: step,
    deadline_exceeded: step,
  };
  const machine: Machine<State, Msg, Cmd, Sub, Ports> = {
    init: (loaded) => [
      {
        agent: loaded?.agent ?? agent.init(),
        msg: null,
        revision: loaded?.revision ?? 0,
      },
      [],
    ],
    update,
    cmds: wired.machine.cmds,
    subs: [{ type: "deadline", deps: (state) => agent.subs(state.agent) }],
  };
  return {
    agent,
    machine,
    interpret: wired.interpret,
    subscribe: wired.subscribe,
  };
}

export function reason(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
