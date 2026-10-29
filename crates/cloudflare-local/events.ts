import { z } from "zod";
import { doEventSourcedStore } from "../../packages/tea/src/do/event-sourced-store";
import {
  applyCellChecked,
  defineMachine,
  type Reducer,
  Refusal,
} from "../../packages/tea/src/index";

const modelSchema = z.strictObject({
  type: z.literal("counting"),
  count: z.number().int(),
});
const eventSchema = z.strictObject({
  type: z.literal("inc"),
  by: z.number().int(),
});
type Model = z.infer<typeof modelSchema>;
type Msg = z.infer<typeof eventSchema>;
const update: Reducer<Model, Msg, never> = {
  inc: (state, msg) => [{ type: "counting", count: state.count + msg.by }, []],
};
const machine = defineMachine({
  init: (loaded: Model | null): readonly [Model, readonly never[]] => [
    loaded ?? { type: "counting", count: 0 },
    [],
  ],
  update,
});
const command = z.discriminatedUnion("action", [
  z.strictObject({
    action: z.enum([
      "seed",
      "state",
      "snapshot",
      "drop-snapshot",
      "delete",
      "wrong-snapshot",
      "restore-snapshot",
      "stale-tail",
      "restore-tail",
      "malformed",
      "restore-row",
      "sdk-failure",
    ]),
  }),
  z.strictObject({
    action: z.enum(["step", "drop-step"]),
    by: z.number().int().min(-100).max(100),
  }),
]);

export class EventJournal {
  private readyCalls = 0;
  private makeStore() {
    return doEventSourcedStore(this.storage, machine, undefined, {
      snapshotEvery: 3,
      parse: (raw) => {
        const parsed = modelSchema.safeParse(raw);
        return parsed.success ? parsed.data : null;
      },
      parseEvent: (raw) => {
        const parsed = eventSchema.safeParse(raw);
        return parsed.success ? parsed.data : null;
      },
      onReady: () => {
        this.readyCalls++;
      },
    });
  }
  private es: ReturnType<EventJournal["makeStore"]>;
  constructor(private readonly storage: DurableObjectStorage) {
    this.es = this.makeStore();
  }
  async command(request: Request): Promise<Response> {
    const parsed = command.safeParse(await request.json());
    if (!parsed.success)
      return new Response("invalid event command", { status: 400 });
    const input = parsed.data;
    let outcome: unknown = null;
    if (input.action === "seed") {
      await this.storage.put("unrelated/keep", "kept");
    } else if (input.action === "delete") {
      const rows = await this.storage.list({ prefix: "@@es/evt/" });
      await this.storage.delete(["@@es/meta", "@@es/snapshot", ...rows.keys()]);
      this.es = this.makeStore();
    } else if (
      input.action === "wrong-snapshot" ||
      input.action === "restore-snapshot"
    ) {
      await this.storage.put(
        "@@es/snapshot",
        JSON.stringify({
          seq: input.action === "wrong-snapshot" ? 2 : 3,
          state: { type: "counting", count: 6 },
        }),
      );
    } else if (
      input.action === "stale-tail" ||
      input.action === "restore-tail"
    ) {
      await this.storage.put(
        "@@es/evt/0000000000000004",
        JSON.stringify({
          type: "inc",
          by: input.action === "stale-tail" ? 40 : 4,
        }),
      );
    } else if (input.action === "malformed" || input.action === "restore-row") {
      if (input.action === "malformed")
        await this.storage.put("@@es/evt/0000000000000006", "{broken}");
      else await this.storage.delete("@@es/evt/0000000000000006");
    }
    if (input.action === "sdk-failure") {
      const original = this.storage.get;
      const cause = new Error("injected event get failure");
      this.storage.get = () => Promise.reject(cause);
      try {
        await this.es.store.load();
        throw new Error("get failure unexpectedly accepted");
      } catch (error) {
        if (error !== cause) throw error;
        outcome = {
          kind: "storage",
          operation: "get",
          original_error: error === cause,
        };
      } finally {
        this.storage.get = original;
      }
    }
    let state: Model;
    try {
      const migrated = this.es.store.migrate(await this.es.store.load());
      if (migrated === null || migrated instanceof Refusal)
        throw new Error("unrecognized recovered model");
      state = migrated;
    } catch (error) {
      if (input.action !== "malformed" || !(error instanceof SyntaxError))
        throw error;
      return Response.json({
        outcome: { kind: "json" },
        ready_calls: this.readyCalls,
        cells: [...(await this.storage.list())],
      });
    }
    if (input.action === "step" || input.action === "drop-step") {
      const msg: Msg = { type: "inc", by: input.by };
      state = applyCellChecked<Model, Msg, never>(machine, state, msg)[0];
      await this.es.store.save(state);
      const before = await this.storage.get<string>("@@es/meta");
      const seq = (before ? JSON.parse(before).lastSeq : 0) + 1;
      const submitted = this.es.append(msg);
      if (input.action === "drop-step") {
        void submitted;
        await this.waitFor("@@es/meta", JSON.stringify({ lastSeq: seq }));
        if (seq % 3 === 0)
          await this.waitFor("@@es/snapshot", JSON.stringify({ seq, state }));
        outcome = { kind: "dropped-append", completed: true };
      } else await submitted;
    } else if (
      input.action === "snapshot" ||
      input.action === "drop-snapshot"
    ) {
      await this.es.store.save(state);
      const submitted = this.es.snapshotNow();
      if (input.action === "drop-snapshot") {
        void submitted;
        const meta = await this.storage.get<string>("@@es/meta");
        const seq = meta ? JSON.parse(meta).lastSeq : 0;
        await this.waitFor("@@es/snapshot", JSON.stringify({ seq, state }));
        outcome = { kind: "dropped-snapshot", completed: true };
      } else outcome = { snapshot: await submitted };
    }
    await this.storage.sync();
    const events = [];
    for await (const row of this.es.readEvents()) events.push(row);
    const window = [];
    for await (const row of this.es.readEvents({ fromSeq: 2, toSeq: 4 }))
      window.push(row);
    return Response.json({
      model: state,
      outcome,
      ready_calls: this.readyCalls,
      events,
      window,
      cells: [...(await this.storage.list())],
    });
  }
  private async waitFor(key: string, expected: string) {
    for (let attempt = 0; attempt < 100; attempt++) {
      if ((await this.storage.get<string>(key)) === expected) return;
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
    throw new Error("dropped journal work did not complete");
  }
}
