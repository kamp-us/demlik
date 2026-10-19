import { applyCell, refuse, type Store } from "@demlik/tea";
import {
  type AgentEndedStatus,
  type AgentEvent,
  agentEvents,
} from "@demlik/tea/agent";
import type { fileJournal } from "@demlik/tea/node";
import { run } from "@demlik/tea/promise";
import { investigation, type Ports, reason } from "./agent";
import {
  type CaseRecord,
  type Evidence,
  parseRecord,
  runIdSchema,
} from "./source";

export type CaseJournal = ReturnType<typeof fileJournal<CaseRecord>>;
type Wiring = ReturnType<typeof investigation>;
type Model = ReturnType<Wiring["agent"]["init"]>;
type State = ReturnType<Wiring["machine"]["init"]>[0];
type Settled = Extract<
  AgentEvent<Evidence>,
  { type: "TurnSettled" | "ToolSettled" | "ToolFailed" | "RunDone" }
>;
type Retained =
  | Settled
  | {
      readonly type: "ContextCompacted";
      readonly runId: string;
      readonly at: number;
      readonly summary: string;
      readonly foldedTurns: number;
    };
export interface CaseView {
  readonly runId: string;
  readonly revision: number;
  readonly history: readonly {
    readonly id: string;
    readonly seq: number;
    readonly event: Retained;
  }[];
  readonly outcome: { readonly kind: "idle" | "running" } | AgentEndedStatus;
  readonly compactions: number;
  readonly maxActiveTurns: number;
  readonly maxActiveTools: number;
}
type Committed = { readonly model: Model; readonly view: CaseView };
export type HostState =
  | { readonly kind: "ready"; readonly committed: Committed }
  | {
      readonly kind: "unavailable";
      readonly reason: string;
      readonly lastCommitted: Committed;
    };
export type CaseFrame = {
  readonly reason: "attached" | "committed" | "overflow";
  readonly view: CaseView;
};
export const MAX_PENDING_VIEWS = 2;

function connection(detach: () => void) {
  let queue: CaseFrame[] = [];
  let waiting: {
    resolve: (frame: IteratorResult<CaseFrame>) => void;
    reject: (error: Error) => void;
  } | null = null;
  let closed = false;
  let failure: Error | null = null;
  let dropped = 0;
  return {
    offer(frame: CaseFrame) {
      if (closed) return;
      if (waiting !== null) {
        const reader = waiting;
        waiting = null;
        reader.resolve({ done: false, value: structuredClone(frame) });
      } else if (queue.length >= MAX_PENDING_VIEWS) {
        dropped += queue.length;
        queue = [{ ...frame, reason: "overflow" }];
      } else {
        queue = [...queue, frame];
      }
    },
    next(): Promise<IteratorResult<CaseFrame>> {
      if (failure !== null) return Promise.reject(failure);
      const frame = queue.shift();
      if (frame !== undefined)
        return Promise.resolve({ done: false, value: structuredClone(frame) });
      if (closed) return Promise.resolve({ done: true, value: undefined });
      if (waiting !== null)
        return Promise.reject(new Error("a case read is already pending"));
      return new Promise((resolve, reject) => {
        waiting = { resolve, reject };
      });
    },
    close(error?: Error) {
      closed = true;
      failure = error ?? null;
      queue = [];
      detach();
      if (waiting !== null) {
        const reader = waiting;
        waiting = null;
        if (error) reader.reject(error);
        else reader.resolve({ done: true, value: undefined });
      }
    },
    backlog: () => ({ pending: queue.length, dropped }),
  };
}
export type CaseConnection = ReturnType<typeof connection>;

export interface CaseHost {
  read(): HostState;
  source(): ReturnType<CaseJournal["list"]>;
  start(): Promise<void>;
  resume(): Promise<void>;
  connect(): Promise<CaseConnection>;
  connections(): number;
  stop(): Promise<void>;
}

export async function openCase(
  journal: CaseJournal,
  runId: string,
  ports: Ports,
): Promise<CaseHost> {
  runIdSchema.parse(runId);
  const wired = investigation(ports);
  const events = agentEvents<
    "investigate",
    "investigate",
    { investigate: import("@demlik/tea/agent").AgentTurn },
    Evidence
  >();
  const initial: Committed = {
    model: wired.agent.init(),
    view: {
      runId,
      revision: 0,
      history: [],
      outcome: { kind: "idle" },
      compactions: 0,
      maxActiveTurns: 0,
      maxActiveTools: 0,
    },
  };
  let state: HostState = { kind: "ready", committed: initial };
  const clients = new Set<CaseConnection>();
  let restored: State | null = null;
  let closed = false;
  const current = (): Committed => {
    if (state.kind === "unavailable") throw new Error(state.reason);
    return state.committed;
  };
  const fail = (error: unknown): void => {
    if (state.kind === "unavailable") return;
    state = {
      kind: "unavailable",
      reason: reason(error),
      lastCommitted: state.committed,
    };
    for (const client of clients) client.close(new Error(state.reason));
  };
  const validate = (record: CaseRecord, previous: Committed): void => {
    if (record.msg.type === "agent_start") {
      if (record.msg.runId !== runId || previous.model.run.phase !== "idle") {
        throw new Error("case source has a foreign or repeated start");
      }
    } else if (previous.model.run.phase === "idle") {
      throw new Error("case source has no start");
    }
  };
  const fold = (
    previous: Committed,
    record: CaseRecord,
    seq: number,
    model: Model,
  ): Committed => {
    if (seq !== previous.view.revision + 1)
      throw new Error("case source sequence is not contiguous");
    const retained: Retained[] = events(record.msg, model).filter(
      (event): event is Settled =>
        event.type === "TurnSettled" ||
        event.type === "ToolSettled" ||
        event.type === "ToolFailed" ||
        event.type === "RunDone",
    );
    const awaiting = previous.model.conversation?.awaiting;
    if (record.msg.type === "compact_ok" && awaiting?.kind === "compacting") {
      retained.push({
        type: "ContextCompacted",
        runId,
        at: record.msg.at,
        summary: record.msg.result.output.summary,
        foldedTurns: awaiting.folding,
      });
    }
    const ending = retained.find((event) => event.type === "RunDone");
    return {
      model,
      view: {
        ...previous.view,
        revision: seq,
        history: [
          ...previous.view.history,
          ...retained.map((event, index) => ({
            id: `${runId}:${seq}:${index}`,
            seq,
            event,
          })),
        ],
        outcome:
          ending?.type === "RunDone"
            ? ending.status
            : model.run.phase === "idle"
              ? { kind: "idle" }
              : previous.view.outcome.kind === "idle"
                ? { kind: "running" }
                : previous.view.outcome,
        compactions:
          previous.view.compactions +
          retained.filter((event) => event.type === "ContextCompacted").length,
        maxActiveTurns: Math.max(
          previous.view.maxActiveTurns,
          model.conversation?.turns.length ?? 0,
        ),
        maxActiveTools: Math.max(
          previous.view.maxActiveTools,
          model.conversation?.toolRecords.length ?? 0,
        ),
      },
    };
  };
  const store: Store<State> = {
    async load() {
      return journal.withLock(runId, async () => {
        let committed = initial;
        for (const entry of await journal.list(runId)) {
          if (entry.stream !== runId)
            throw new Error("case source has a foreign stream");
          const record = parseRecord(entry.record);
          validate(record, committed);
          const [next] = applyCell(
            wired.machine,
            {
              agent: committed.model,
              msg: null,
              revision: committed.view.revision,
            },
            record.msg,
          );
          committed = fold(committed, record, entry.seq, next.agent);
        }
        state = { kind: "ready", committed };
        restored =
          committed.view.revision === 0
            ? null
            : {
                agent: committed.model,
                msg: null,
                revision: committed.view.revision,
              };
        return restored;
      });
    },
    migrate: (raw) =>
      raw === restored
        ? restored
        : refuse("case store only accepts its parsed source"),
    async save(next) {
      if (next.msg === null) return;
      try {
        await journal.withLock(runId, async () => {
          const previous = current();
          if (next.revision === previous.view.revision) return;
          if (next.revision !== previous.view.revision + 1) {
            throw new Error("case save revision is not the next source entry");
          }
          const record = parseRecord({ version: 1, msg: next.msg });
          validate(record, previous);
          const { seq } = await journal.append(runId, record);
          const committed = fold(previous, record, seq, next.agent);
          state = { kind: "ready", committed };
          for (const client of clients)
            client.offer({ reason: "committed", view: committed.view });
        });
      } catch (error) {
        fail(error);
        throw error;
      }
    },
  };
  const runtime = await run(wired.machine, {
    interpret: wired.interpret,
    subscribe: wired.subscribe,
    ctx: ports,
    store,
    clock: ports.now,
    onError: fail,
  }).ready;
  const ensureOpen = () => {
    if (closed) throw new Error("case host is closed");
    current();
  };
  return {
    read: (): HostState => structuredClone(state),
    async source() {
      return journal.list(runId);
    },
    async start() {
      ensureOpen();
      if (current().model.run.phase !== "idle")
        throw new Error("case has already started");
      await runtime.dispatch({ type: "agent_start", runId, at: ports.now() });
      current();
    },
    async resume() {
      ensureOpen();
      if (
        current().model.run.phase !== "idle" &&
        !wired.agent.isSettled(current().model)
      ) {
        await runtime.dispatch({ type: "agent_boot", at: ports.now() });
      }
      current();
    },
    async connect(): Promise<CaseConnection> {
      ensureOpen();
      return journal.withLock(runId, async () => {
        ensureOpen();
        const client = connection(() => clients.delete(client));
        clients.add(client);
        client.offer({ reason: "attached", view: current().view });
        return client;
      });
    },
    connections: () => clients.size,
    async stop() {
      closed = true;
      for (const client of clients) client.close();
      await runtime.stop();
    },
  };
}

export function caseResponse(client: CaseConnection): Response {
  const encoder = new TextEncoder();
  return new Response(
    new ReadableStream<Uint8Array>(
      {
        async pull(controller) {
          try {
            const frame = await client.next();
            if (frame.done) controller.close();
            else
              controller.enqueue(
                encoder.encode(
                  `id: ${frame.value.view.runId}:${frame.value.view.revision}\nevent: case\ndata: ${JSON.stringify(frame.value)}\n\n`,
                ),
              );
          } catch (error) {
            controller.error(error);
          }
        },
        cancel: () => client.close(),
      },
      { highWaterMark: 0 },
    ),
    {
      headers: {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
      },
    },
  );
}
