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

To wake and resume a suspended run *without* waiting for a request — plus an
SSE stream of the agent's events — the host assembly is `createAgentHost` from
`@demlik/tea/do` (see [the reference](../reference/do.md)); it wires the same
resume path (`autoBoot`) at activation. If the Durable Object also runs
Cloudflare's `agents` SDK, which owns the alarm and a state table of its own,
the coexistence rules are being written under
[kamp-us/demlik#34](https://github.com/kamp-us/demlik/issues/34); this guide
does not cover that composition.
