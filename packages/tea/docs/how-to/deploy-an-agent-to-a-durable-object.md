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

Call it from the request or alarm that wakes the object: `host.runtime()` is the
point where a restored run starts working again.

### Stop: the run's signal

Stopping a run is tea's own `signal`, given to the engine's `run`. The Durable
Object keeps one `AbortController` per run in memory and hands its signal to
`run` with the Msg that cancels. A stop request records `stop:<runId>`, then
aborts the controller. A wake that finds the key set aborts it before any request
is served.

```ts
const stop = new AbortController();

const host = createAgentHost({
  run: (machine, options) =>
    run(machine, {
      ...options,
      cancellation: {
        signal: stop.signal,
        cancel: () => agentCancelMsg(Date.now()),
      },
    }),
  buildMachine: () => agent.toMachine<object>({ toolInterpret }),
  store: doStore(this.ctx.storage, parse),
  ctx: {},
  toSseFrame: () => null,
});

// In the constructor, before any request: a recorded stop aborts the signal.
this.ctx.blockConcurrencyWhile(async () => {
  if ((await this.ctx.storage.get<boolean>(`stop:${runId}`)) === true)
    stop.abort();
});

// The stop request: record it, then abort. It does not wait on the run.
await this.ctx.storage.put(`stop:${runId}`, true);
stop.abort();

// The pull's admission: the hands settle nothing for a stopped run.
const admit = async () =>
  (await this.ctx.storage.get<boolean>(`stop:${runId}`)) === true
    ? { done: true as const, output: (await host.status()).kind }
    : null;

const steps = stepHost({ storage: owner }, { ...engine, beforeResume: admit });
```

Once the signal aborts, the runtime queues `agentCancelMsg`, starts no further
model call, compaction or tool, and stops waiting on the tool the run is parked
on, so the stop never waits for a tool nobody has answered. The tool's handler
runs to its own end, and what it returns reaches no one. A signal that is already
aborted when the object wakes, or that aborts while the run is still loading,
settles the run `cancelled` before `host.runtime()` resolves, so a stopped run
re-fires nothing.

`stepHost` calls `beforeResume` for every authenticated pull, including the first
pull and a repeated post, after the token check and before it settles a posted
result, defers it, or reads the next step. Returning `null` continues as a host
without the hook does. Here it reads the key the stop request wrote and answers
with the run's status, so the hands of a stopped run settle nothing. It stops
nothing; the abort did. A pull answered before the cancel has folded reads the
run as it stood, and a stop that arrives after the hook returned is outside it. A
throw or a rejection from the hook propagates out of `handle`, and the same
result posted again is still treated as new.

Do not stop the run with `host.reset()`. It is the test and lifecycle seam, for
one caller at a time: a second `reset()` while one is stopping the run, a
`reset()` before `run()` has returned its handle, and a `runtime()` while a
`reset()` is stopping the run each throw a `HostOverlapError`. `engine` is the
`StepEngine` you already pass.

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
