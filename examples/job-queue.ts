import {
  type Cmd,
  defineMachine,
  run,
  type Store,
  tryInterpret,
} from "@demlik/tea";
import { createQueue, type QueueItem } from "@demlik/tea/work-queue";

interface Job {
  readonly name: string;
  readonly payload: number;
}

type Phase = "draining" | "drained";

interface State {
  readonly phase: Phase;
  readonly maxAttempts: number;
  readonly attempts: Readonly<Record<string, number>>;
  readonly running: string | null;
  readonly done: readonly string[];
  readonly deadLettered: readonly string[];
  readonly log: readonly string[];
}

type ClaimNext = Cmd<"claim_next">;
type RunJob = Cmd<"run_job"> & {
  readonly id: string;
  readonly name: string;
  readonly payload: number;
};
type Complete = Cmd<"complete"> & {
  readonly id: string;
  readonly name: string;
};
type Requeue = Cmd<"requeue"> & {
  readonly id: string;
  readonly name: string;
  readonly attempt: number;
};
type DeadLetter = Cmd<"dead_letter"> & {
  readonly id: string;
  readonly name: string;
  readonly error: string;
};
type JobCmd = ClaimNext | RunJob | Complete | Requeue | DeadLetter;

type Msg =
  | { type: "tick" }
  | { type: "claimed"; item: QueueItem<Job> | null }
  | { type: "ran_ok"; id: string; name: string }
  | { type: "ran_err"; id: string; name: string; error: string }
  | { type: "settled" };

interface Ctx {
  readonly queue: ReturnType<typeof createQueue<Job>>;
  readonly worker: (job: Job) => Promise<string>;
}

function memStore<I>(): Store<QueueItem<I>[]> {
  let cell: QueueItem<I>[] = [];
  return {
    load: async () => cell,
    save: async (next) => {
      cell = next;
    },
    migrate: (raw) => (Array.isArray(raw) ? (raw as QueueItem<I>[]) : null),
  };
}

const flakyWorker = (job: Job): Promise<string> =>
  job.payload < 0
    ? Promise.reject(new Error(`negative payload ${job.payload}`))
    : Promise.resolve(`processed ${job.name} -> ${job.payload * 2}`);

export const jobQueue = defineMachine<State, Msg, JobCmd, never, Ctx>({
  init: (loaded) =>
    loaded !== null
      ? [loaded, []]
      : [
          {
            phase: "draining",
            maxAttempts: 3,
            attempts: {},
            running: null,
            done: [],
            deadLettered: [],
            log: [],
          },
          [{ type: "claim_next" }],
        ],

  update: {
    tick: (s) =>
      s.phase === "drained" ? [s, []] : [s, [{ type: "claim_next" }]],

    claimed: (s, m) => {
      if (m.item === null) {
        return [
          { ...s, phase: "drained", log: [...s.log, "queue drained"] },
          [],
        ];
      }
      const item = m.item;
      const attempt = (s.attempts[item.id] ?? 0) + 1;
      return [
        {
          ...s,
          running: item.id,
          attempts: { ...s.attempts, [item.id]: attempt },
          log: [...s.log, `claim ${item.input.name} (attempt ${attempt})`],
        },
        [
          {
            type: "run_job",
            id: item.id,
            name: item.input.name,
            payload: item.input.payload,
          },
        ],
      ];
    },

    ran_ok: (s, m) => [
      {
        ...s,
        running: null,
        done: [...s.done, m.name],
        log: [...s.log, `done ${m.name}`],
      },
      [{ type: "complete", id: m.id, name: m.name }],
    ],

    ran_err: (s, m) => {
      const attempt = s.attempts[m.id] ?? 0;
      if (attempt < s.maxAttempts) {
        return [
          {
            ...s,
            running: null,
            log: [...s.log, `retry ${m.name} (${m.error})`],
          },
          [{ type: "requeue", id: m.id, name: m.name, attempt }],
        ];
      }
      return [
        {
          ...s,
          running: null,
          deadLettered: [...s.deadLettered, m.name],
          log: [...s.log, `dead-letter ${m.name} after ${attempt} attempts`],
        },
        [{ type: "dead_letter", id: m.id, name: m.name, error: m.error }],
      ];
    },

    settled: (s) =>
      s.phase === "drained" ? [s, []] : [s, [{ type: "claim_next" }]],
  },

  interpret: {
    claim_next: async (_cmd, ctx) => {
      const item = await ctx.queue.claimNext();
      return { type: "claimed", item };
    },

    run_job: tryInterpret<RunJob, string, Msg, Ctx>(
      (cmd, ctx) => ctx.worker({ name: cmd.name, payload: cmd.payload }),
      (_value, cmd) => ({ type: "ran_ok", id: cmd.id, name: cmd.name }),
      (error, cmd) => ({
        type: "ran_err",
        id: cmd.id,
        name: cmd.name,
        error: error instanceof Error ? error.message : String(error),
      }),
    ),

    complete: async (cmd, ctx) => {
      await ctx.queue.markDone(cmd.id);
      return { type: "settled" };
    },

    requeue: async (cmd, ctx) => {
      await ctx.queue.retryItem(cmd.id);
      return { type: "settled" };
    },

    dead_letter: async (cmd, ctx) => {
      await ctx.queue.markFailed(cmd.id, cmd.error);
      return { type: "settled" };
    },
  },
});

async function main() {
  const queue = createQueue<Job>(memStore<Job>());
  const ctx: Ctx = { queue, worker: flakyWorker };

  await queue.enqueue({ name: "resize-avatars", payload: 12 });
  await queue.enqueue({ name: "charge-card", payload: -1 });
  await queue.enqueue({ name: "send-receipt", payload: 7 });

  console.log("enqueued 3 jobs:");
  for (const item of await queue.list()) {
    console.log(`  ${item.input.name}  payload=${item.input.payload}`);
  }

  const runtime = await run(jobQueue, { ctx }).ready;

  const drained = new Promise<void>((resolve) => {
    const off = runtime.subscribe(() => {
      if (runtime.getState().phase === "drained") {
        off();
        resolve();
      }
    });
  });
  await drained;

  const final = runtime.getState();
  console.log("\nrun:");
  for (const entry of final.log) console.log(`  ${entry}`);

  const leftover = await queue.list();
  const pending = leftover.filter((i) => i.status === "pending").length;
  const failed = leftover.filter((i) => i.status === "failed").length;

  console.log("\npartition:");
  console.log(`  pending  ${pending}`);
  console.log(`  running  ${final.running === null ? 0 : 1}`);
  console.log(`  done     ${final.done.length}  [${final.done.join(", ")}]`);
  console.log(`  failed   ${failed}  [${final.deadLettered.join(", ")}]`);

  await runtime.stop();
}

main();
