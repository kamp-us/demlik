# Deploy an agent to a Durable Object

To run a `defineAgent` agent on Cloudflare, give `agent.run` a `Store` backed by
the Durable Object's storage. The tool, the `defineAgent` and the `agent.run`
are the three lines from [Build a durable agent](../tutorial/build-a-durable-agent.md);
only the `Store` changes, from `@demlik/tea/node`'s `fileStore` to
`@demlik/tea/do`'s `doStore`. The Model is saved after every transition, so a
DO evicted mid-run resumes on its next request rather than starting over.

## 1. Move the agent's definition into the Durable Object

The model needs the API key, and on Workers a secret arrives on `env`, not
`process.env` — so the agent is defined where `env` is in scope. `model.ts` is
the adapter from the tutorial, unchanged; `note` is the same `tool()`, exported
from its own `note.ts`:

```ts
import { DurableObject } from "cloudflare:workers";
import { type DefinedAgentState, defineAgent } from "@demlik/tea/agent";
import { doStore } from "@demlik/tea/do";
import { anthropic } from "./model";
import { note } from "./note";

interface Env {
  readonly ANTHROPIC_API_KEY: string;
}

export class Notebook extends DurableObject<Env> {
  async fetch(request: Request): Promise<Response> {
    const agent = defineAgent({
      model: anthropic([note], this.env.ANTHROPIC_API_KEY),
      tools: [note],
      instructions: "You keep a notebook. Save one note per turn, then answer in one line.",
    });
    const final = await agent.run(await request.text(), {
      store: doStore(this.ctx.storage, (raw) => raw as DefinedAgentState<typeof note>),
    });
    return Response.json({ answer: final.output?.content });
  }
}
```

`doStore(storage, parse)` reads and writes one key of `DurableObjectStorage`;
the `parse` is the same trust-the-file function as the tutorial's, because this
DO is the only writer of that key.

## 2. Route a request at one DO per run

One Durable Object instance is one run: its storage holds one Model, and
`agent.run` reads it on every request. Name the instance by the run:

```ts
export default {
  async fetch(request: Request, env: { NOTEBOOK: DurableObjectNamespace<Notebook> }) {
    const runId = new URL(request.url).searchParams.get("run") ?? "default";
    return env.NOTEBOOK.get(env.NOTEBOOK.idFromName(runId)).fetch(request);
  },
};
```

With the binding in `wrangler.toml` and the secret set:

```sh
wrangler secret put ANTHROPIC_API_KEY
wrangler deploy
curl -X POST "https://<worker>/?run=colours" \
  --data "Note the three primary colours, one per note, then tell me you are done."
```

## 3. What a mid-run eviction does

If the runtime evicts the DO while `agent.run` is awaiting the model, the Model
in storage already holds every transition up to that call. The next request to
the same instance runs the same `agent.run`, which boots the stored Model at its
outstanding effect — same `runId`, the tool outcomes already folded — and
finishes. A request to an instance whose run is `done` gets the stored answer
back without a model call; a fresh input needs a fresh instance name.

## 4. Compose the host yourself: wake, stop and deadline

The sections above use `defineAgent` and `agent.run`, which build and boot their
own run. A Durable Object that holds the run itself, answers `/step` pulls from a
driver and wakes on an alarm composes the pieces from `@demlik/tea/do` instead:
a `createAgent` agent wired through `toMachine` and `createAgentHost`. That is a
different host with a different owner of boot, so use one host or the other for a
run, never both. Each block below is a piece of that Durable Object.

### Wake: reissue the outstanding operation once

`host.runtime()` builds the machine from the stored Model, waits for it to boot,
and dispatches `agent_boot` once if the run was `running` or `suspended`. That
covers a run lost while its model call or its compaction was in flight, and one
lost while its tools were. The one outstanding operation is issued again, and the
tool results already folded are not read again. `host.runtime()` resolves once
`agent_boot` is queued, not when the work it re-fired is done, so a run waiting
on a tool your driver has not answered does not hold it up. A run that is `idle`,
`done`, `failed` or `cancelled` is left alone. Do not dispatch `agent_boot`
yourself beside it, or the run boots twice.

```ts
const host = createAgentHost({
  run,
  buildMachine: () => agent.toMachine<object>({ toolInterpret }),
  store: doStore(this.ctx.storage, parse),
  ctx: {},
  toSseFrame: () => null,
});

// The first caller boots; every other caller shares that boot.
const runtime = await host.runtime();
```

Call it from the request or alarm that wakes the object, once the stop below has
been read: `host.runtime()` is the point where a restored run starts working
again.

### Stop: answer the pull before any work resumes

A stop your application recorded has to be read before `host.runtime()` runs,
because that call reissues the outstanding operation, and that may be a model
call. Give `stepHost` an engine whose `beforeResume` reads the stop from your own
storage, cancels the run through a runtime that boots nothing, and returns the
terminal response. `stepHost` calls it for every authenticated pull, including
the first pull and a repeated post, after the token check and before it settles
a posted result, defers it, or reads the next step. Returning `null` continues as
a host without the hook does.

```ts
const store = doStore(this.ctx.storage, parse);

const admit = async (runId: string) => {
  if (!(await this.ctx.storage.get<boolean>(`stop:${runId}`))) return null;
  await host.reset();
  const wired = agent.toMachine<object>({ toolInterpret });
  const stopped = await run(wired.machine, { ...wired, store, ctx: {} }).ready;
  await stopped.dispatch(agentCancelMsg(Date.now()));
  const { kind } = status(stopped.getState());
  await stopped.stop();
  return { done: true as const, output: kind };
};

const steps = stepHost({ storage: owner }, { ...engine, beforeResume: admit });
```

`engine` is the `StepEngine` you already pass; `host.reset()` stops the runtime
an earlier pull started, even one waiting on a tool, so only one runtime writes
the run. `beforeResume` bounds
the pull it runs in. A model call that has already started, or a stop that
arrives after the hook returned, is outside it, and a worker that runs queued
work later has to check the stop again itself. A throw or a rejection from the
hook propagates out of `handle`, and the same result posted again is still
treated as new.

### Deadline: arm it when the run is created

A Durable Object alarm only schedules a wake: the platform calls your `alarm()`
handler at that time, and setting one ends nothing. The handler has to persist
the outcome you want, such as the run's expiry or a cancel. `durableTimer` is the
existing helper for that loop: `rearm()` computes the next deadline and arms it,
and `onAlarm()` runs your `onFire` and then re-arms.

Store the absolute deadline when the run is created, and `await timer.rearm()`
before you return the run's capability to the driver. A run whose driver never
sends its first pull then still reaches its deadline. After a cold wake, rebuild
the timer from the stored deadline and never from `Date.now() + timeout`, which
would move the deadline later on every wake.

```ts
interface Deadlines {
  startupBy: number | null;
  absoluteBy: number;
  idleBy: number | null;
  expired: boolean;
}

const earliestActive = (d: Deadlines): number | null =>
  d.expired
    ? null
    : Math.min(
        ...[d.startupBy, d.absoluteBy, d.idleBy].filter(
          (at): at is number => at !== null,
        ),
      );

const key = `deadlines:${this.runId}`;

const owner: AlarmStorage = {
  setAlarm: async (requestedAt) => {
    const d = await this.ctx.storage.get<Deadlines>(key);
    if (d === undefined) return;
    const next = { ...d, startupBy: null, idleBy: requestedAt };
    await this.ctx.storage.put(key, next);
    const at = earliestActive(next);
    if (at !== null) await this.ctx.storage.setAlarm(at);
  },
};

const timer = durableTimer({
  alarm: this.ctx.storage,
  nextDeadline: async () => {
    const d = await this.ctx.storage.get<Deadlines>(key);
    return d === undefined ? null : earliestActive(d);
  },
  onFire: () => this.expire(),
});

// Run creation: persist, arm, then answer.
await this.ctx.storage.put(key, {
  startupBy: Date.now() + STARTUP_MS,
  absoluteBy: Date.now() + MAX_RUN_MS,
  idleBy: null,
  expired: false,
} satisfies Deadlines);
await timer.rearm();
return Response.json({ runId: this.runId, token });

// The Durable Object's alarm handler.
async alarm() {
  await timer.onAlarm();
}
```

`this.runId` is the run this Durable Object holds, and `this.expire()` is your own
method: it marks `expired` in the stored deadlines and cancels the run, so the
timer finds nothing left to arm.

A Durable Object has one alarm, and `stepHost` also calls
`setAlarm(now + giveUpAfterMs)` on every authenticated request to re-arm its idle
give-up. A second writer would overwrite the first, so one function owns the
alarm: `earliestActive`, over the deadlines you persisted. The timer arms exactly
what `earliestActive` returns. `stepHost` gets `owner`, which records its idle
request and arms the same earliest value, and that is the `owner` the stop block
passes to `stepHost`. A pull moves the idle deadline and ends the startup
window, and never postpones the absolute deadline.

This is host policy, not a cancellation rule of tea's. If the Durable Object also
runs Cloudflare's `agents` SDK, which owns the alarm and a state table of its
own, do not override its alarm: adapt `AlarmStorage` onto its scheduler as
[Coexisting with Cloudflare's `agents` SDK](../explanation/agents-sdk-coexistence.md)
shows. This guide does not cover the rest of that composition.
