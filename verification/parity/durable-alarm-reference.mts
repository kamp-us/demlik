import { readFileSync } from "node:fs";
import { z } from "zod";
import { durableTimer } from "../../packages/tea/src/do/durable-timer.ts";
import { doStore } from "../../packages/tea/src/do/index.ts";
import { defineMachine } from "../../packages/tea/src/index.ts";
import { step } from "../../packages/tea/src/testing/assertions.ts";

const scripts = z
  .array(
    z.object({
      name: z.string(),
      jobs: z.array(z.number()),
      fault: z.enum(["fire", "deadline", "alarm"]).optional(),
      actions: z.array(z.enum(["cold", "change", "held", "rearm", "alarm"])),
    }),
  )
  .parse(JSON.parse(readFileSync(0, "utf8")));
type Model = { pending: number[]; done: number[] };
const out = [];
for (const script of scripts) {
  const trace: unknown[][] = [],
    alarms: number[] = [],
    results: unknown[] = [];
  const cells = new Map<string, string>();
  const storage = {
    async get(key: string) {
      trace.push(["get", key]);
      return cells.get(key);
    },
    async put(key: string, value: string) {
      trace.push(["put", key, value]);
      cells.set(key, value);
    },
  };
  const store = () =>
    doStore(
      storage as unknown as Parameters<typeof doStore>[0],
      (x) => x as Model,
    );
  let model: Model = { pending: script.jobs.slice(), done: [] };
  const machine = defineMachine({
    init: (loaded: Model) => [loaded, []] as const,
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
  await store().save(model);
  let release: (() => void) | undefined,
    held = false;
  const fault = {
    phase: script.fault,
    message: "scheduled failure",
    payload: { code: 17 },
  };
  const timer = () =>
    durableTimer({
      alarm: {
        async setAlarm(at) {
          trace.push(["alarm", at]);
          if (script.fault === "alarm") throw fault;
          alarms.push(at);
        },
      },
      async nextDeadline() {
        trace.push(["deadline"]);
        if (script.fault === "deadline") throw fault;
        return model.pending[0] ?? null;
      },
      async onFire() {
        trace.push(["fire-start"]);
        if (script.fault === "fire") throw fault;
        if (held)
          await new Promise<void>((r) => {
            release = r;
          });
        model = step(machine, model, { type: "fire" }, undefined)[0];
        await store().save(model);
        trace.push(["fire-end"]);
      },
    });
  let host = timer();
  for (const action of script.actions) {
    try {
      if (action === "cold") {
        model = store().migrate(await store().load());
        host = timer();
      } else if (action === "change") {
        model = { ...model, pending: [777, ...model.pending.slice(1)] };
        await store().save(model);
      } else if (action === "held") {
        held = true;
        const pending = host.onAlarm();
        await Promise.resolve();
        results.push({
          held: structuredClone({ trace, alarms, model, cells: [...cells] }),
        });
        release?.();
        await pending;
        held = false;
      } else if (action === "rearm") await host.rearm();
      else await host.onAlarm();
      results.push({ action, ok: true });
    } catch (error) {
      results.push({ action, ok: false, error, sameOriginal: error === fault });
    }
  }
  out.push({
    name: script.name,
    trace,
    alarms,
    model,
    cells: [...cells],
    results,
  });
}
console.log(JSON.stringify(out));
