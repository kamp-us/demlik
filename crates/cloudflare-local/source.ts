import { z } from "zod";
import { durableTimer } from "../../packages/tea/src/do/durable-timer";
import { doStore } from "../../packages/tea/src/do/index";
import {
  applyCellChecked,
  defineMachine,
  Refusal,
  refuse,
} from "../../packages/tea/src/index";
import { EventJournal } from "./events";
import { transactions } from "./transactions";

const deadline = z.number().int().min(0).max(8.64e15);
const seedSchema = z.strictObject({
  jobs: z
    .tuple([deadline, deadline, deadline])
    .refine(
      (jobs) => jobs[0] < jobs[1] && jobs[1] < jobs[2],
      "deadlines must be strictly increasing",
    ),
});
const snapshot = z.strictObject({
  pending: z.array(deadline),
  done: z.array(deadline),
});
type Model = z.infer<typeof snapshot>;
const machine = defineMachine({
  init: (loaded: Model | null) =>
    [loaded ?? { pending: [], done: [] }, []] as const,
  update: {
    fire: (state: Model) =>
      [
        {
          pending: state.pending.slice(1),
          done: state.pending.length
            ? [...state.done, state.pending[0]]
            : state.done,
        },
        [],
      ] as const,
  },
});
type Action =
  | { type: "seed"; jobs: number[] }
  | { type: "state" | "alarm" | "repeat" };
const log = (record: unknown) => console.log(JSON.stringify(record));

export class SourceJobs {
  private readonly events: EventJournal;
  constructor(private readonly state: DurableObjectState) {
    log({ event: "constructor", at: Date.now() });
    this.events = new EventJournal(state.storage);
  }
  private async callback(action: Action): Promise<Response> {
    const storage = this.state.storage;
    const store = doStore(storage, (raw) => {
      if (raw === null) return null;
      const checked = snapshot.safeParse(raw);
      return checked.success ? checked.data : refuse(checked.error.message);
    });
    const loaded = store.migrate(await store.load());
    if (loaded instanceof Refusal) throw new Error("invalid snapshot");
    let model = machine.init(loaded ?? { pending: [], done: [] }, undefined)[0];
    const timer = durableTimer({
      alarm: {
        async setAlarm(at) {
          await storage.setAlarm(at);
          log({ event: "set_alarm", at });
        },
      },
      nextDeadline: () => model.pending[0] ?? null,
      async onFire() {
        const now = Date.now();
        while (model.pending.length && model.pending[0] <= now) {
          model = applyCellChecked<Model, { type: "fire" }, never>(
            machine,
            model,
            { type: "fire" },
          )[0];
          await store.save(model);
          log({ event: "transition_saved", model });
        }
      },
    });
    if (action.type === "seed") {
      if (model.pending.length || model.done.length)
        return new Response("already seeded", { status: 409 });
      model = { pending: action.jobs, done: [] };
      await store.save(model);
      await timer.rearm();
    } else if (action.type === "alarm" || action.type === "repeat") {
      log({ event: "callback", origin: action.type, at: Date.now(), model });
      await timer.onAlarm();
    }
    await storage.sync();
    return Response.json({
      model,
      alarm: await storage.getAlarm(),
      stored_json: (await storage.get<string>("@@state")) ?? null,
    });
  }
  async fetch(request: Request): Promise<Response> {
    const path = new URL(request.url).pathname;
    if (request.method === "POST" && path === "/events")
      return this.events.command(request);
    if (request.method === "POST" && path === "/transactions")
      return transactions(this.state.storage, request);
    if (request.method === "POST" && path === "/seed") {
      let raw: unknown;
      try {
        raw = await request.json();
      } catch {
        return new Response("invalid JSON", { status: 400 });
      }
      const checked = seedSchema.safeParse(raw);
      if (!checked.success || checked.data.jobs[0] <= Date.now())
        return new Response("invalid future schedule", { status: 400 });
      return this.callback({ type: "seed", jobs: checked.data.jobs });
    }
    if (request.method === "POST" && path === "/repeat") {
      await request.arrayBuffer();
      return this.callback({ type: "repeat" });
    }
    if (request.method === "GET" && path === "/state")
      return this.callback({ type: "state" });
    return new Response("not found", { status: 404 });
  }
  async alarm(): Promise<void> {
    await this.callback({ type: "alarm" });
  }
}
export default {
  fetch(
    request: Request,
    env: { JOBS: DurableObjectNamespace },
  ): Promise<Response> {
    return env.JOBS.get(env.JOBS.idFromName("three-jobs")).fetch(request);
  },
};
