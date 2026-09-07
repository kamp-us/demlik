# Build a durable agent

In this lesson you build an agent that keeps a notebook, run it against a real
model, and then do the thing that makes `@demlik/tea` worth using for agents:
kill the process in the middle of the run, run it again, and watch it pick up
exactly where it stopped — same run, no tool called twice. By the end you will
have written one tool, one `defineAgent`, and one `agent.run`, and seen the
whole run live in a JSON file you can open.

## Set up the project

You need Node 22 or newer and an Anthropic API key in `ANTHROPIC_API_KEY`. In an
empty directory:

```sh
pnpm init
npm pkg set type=module
pnpm add @demlik/tea @anthropic-ai/sdk zod
```

The `type=module` line is not optional. `pnpm init` writes a CommonJS
`package.json`, and `agent.ts` below ends in a top-level `await` — without
`"type": "module"` TypeScript rejects them with TS1309 ("await is only allowed
at the top level of a file when that file is a module"), which points at the
`await` rather than at the missing field.

The agent is two files. `model.ts` is the brain — the wire format of one model
provider, nothing about tea. `agent.ts` is the part this lesson is about.

## Give the agent a brain

tea hands a model plain messages and expects a *turn* back: what the model said
and which tools it wants called. The adapter below is that translation for
Anthropic's Messages API — tea's tool outcomes ride as `tool_result` blocks, and
the model's `tool_use` blocks come back as tool calls.

One naming note before you read it. A tool is declared below with a name and an
`input:` schema; on this side of the seam those two are `cmdType` and `args` —
`cmdType` because a tool is a command constructor, `args` because the schema
names what the *model's* arguments are parsed against. Same two things, and the
adapter reads them under those names:

```ts
// model.ts
import Anthropic from "@anthropic-ai/sdk";
import type { AgentMessage, AgentTurn, AnyToolDef } from "@demlik/tea/agent";
import { z } from "zod";

/** Anthropic's Messages API as tea's plain `(messages) => turn` model port. */
export function anthropic(tools: readonly AnyToolDef[], apiKey?: string) {
  const client = new Anthropic({ apiKey });
  const declared: Anthropic.Tool[] = tools.map((t) => ({
    name: t.cmdType,
    description: t.description,
    input_schema: z.toJSONSchema(t.args) as Anthropic.Tool.InputSchema,
  }));
  return async (messages: readonly AgentMessage[]): Promise<AgentTurn> => {
    const response = await client.messages.create({
      model: "claude-opus-5",
      max_tokens: 4096,
      thinking: { type: "adaptive" },
      system: messages.find((m) => m.role === "system")?.content,
      tools: declared,
      messages: messages.flatMap(toParam),
    });
    return {
      content: response.content
        .flatMap((b) => (b.type === "text" ? b.text : []))
        .join(""),
      toolCalls: response.content.flatMap((b) =>
        b.type === "tool_use"
          ? { callId: b.id, name: b.name, args: b.input as Record<string, unknown> }
          : [],
      ),
      // Signed thinking blocks: the API wants them back verbatim next turn.
      provider: response.content.filter(
        (b) => b.type !== "text" && b.type !== "tool_use",
      ),
    };
  };
}

/** One tea message in Anthropic's shape; the system line goes to `system`. */
function toParam(m: AgentMessage): Anthropic.MessageParam[] {
  switch (m.role) {
    case "system":
      return [];
    case "user":
      return [{ role: "user", content: m.content }];
    case "assistant":
      return [
        {
          role: "assistant",
          content: [
            ...((m.provider as Anthropic.ContentBlockParam[] | undefined) ?? []),
            ...(m.content === ""
              ? []
              : [{ type: "text" as const, text: m.content }]),
            ...m.toolCalls.map((c) => ({
              type: "tool_use" as const,
              id: c.callId,
              name: c.name,
              input: c.args,
            })),
          ],
        },
      ];
    case "tool":
      return [
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: m.callId,
              content: JSON.stringify(m.outcome),
              is_error: m.outcome.kind !== "ok",
            },
          ],
        },
      ];
  }
}
```

The turn's `provider` slot is how the signed `thinking` blocks survive a resume:
tea saves whatever the adapter puts there with the turn and hands it back on the
`assistant` message, never reading it, so the transcript a resumed process
replays carries the blocks Anthropic requires beside its text and tool calls.

Swap this file for any provider's SDK and nothing below changes: the port is one
`async` function from messages to a turn.

## Declare a tool

A tool is declared once, with `tool()`: its name, what it takes, what it returns,
the failures it may name, and the handler. The one below appends a line to
`notes.txt` and says so on the console, which is how you will see the run
happen:

```ts
// agent.ts
import { type DefinedAgentState, defineAgent, tool } from "@demlik/tea/agent";
import { fileStore } from "@demlik/tea/node";
import { appendFile } from "node:fs/promises";
import { z } from "zod";
import { anthropic } from "./model.ts";

const note = tool(
  "note",
  {
    description: "Append one line to the notebook",
    input: z.object({ text: z.string() }),
    ok: z.object({ saved: z.boolean() }),
    err: [],
  },
  async ({ text }, _ctx, { ok }) => {
    console.log("note:", text);
    await appendFile("notes.txt", `${text}\n`);
    return ok({ saved: true });
  },
);
```

The `input` schema is what the model's arguments are parsed against before the
handler ever sees them; `description` is the sentence the model reads to decide
when to call the tool.

## Define the agent

`defineAgent` takes the three things that are actually yours to decide — the
brain, the tools, the instructions — and wires the rest:

```ts
const agent = defineAgent({
  model: anthropic([note], process.env.ANTHROPIC_API_KEY),
  tools: [note],
  instructions:
    "You keep a notebook. Save exactly one note per turn; when every fact is saved, answer in one line.",
});
```

"The rest" is the loop you did not write. `defineAgent`:

- renders the prompt — instructions, input, every turn so far with its tool
  outcomes — and calls your `model` with it;
- validates the turn that comes back, and reads its tool calls;
- parses each call's `args` against that tool's `input` schema, rejecting an
  unknown tool or malformed args as an outcome rather than a throw;
- runs the matching handler and folds its outcome back into the conversation, so
  the next prompt carries it;
- repeats until a turn asks for no tools, then resolves;
- and, with a `store`, writes the Model after every transition — which is what
  the next section resumes from.

"One note per turn" is there so the run has several model round-trips to be
interrupted between.

## Run it, durably

`agent.run` drives the agent to its final Model. Hand it a `Store` and every
transition is saved before the next one starts — here a JSON file, via
`fileStore` from `@demlik/tea/node`:

```ts
const final = await agent.run(
  "Note the three primary colours, one per note, then tell me you are done.",
  { store: fileStore("agent.json", (raw) => raw as DefinedAgentState<typeof note>) },
);
console.log("done:", final.output?.content);
```

`fileStore` asks for a parse function because a file is a real serialization
boundary; this one trusts the file, which is right for a file this program
wrote. `DefinedAgentState` is parameterised by the tools the agent may call, so
it takes their union — with a second tool the type reads
`DefinedAgentState<typeof note | typeof lookup>`, and so on for a third. Run it:

```sh
node --experimental-strip-types agent.ts
```

You will see three `note:` lines and then `done:`, and two new files beside the
script: `notes.txt` with the three colours, and `agent.json` — the agent's whole
Model, including the conversation so far.

## Kill it mid-run, run it again

Delete both files and run again, but this time press `Ctrl-C` as soon as the
first `note:` line appears. Then look at what was left behind:

```sh
rm -f agent.json notes.txt
node --experimental-strip-types agent.ts   # Ctrl-C after the first "note:"
cat notes.txt                              # one colour
node -p "require('./agent.json').run.runId"
```

Now run the same command again, with nothing changed:

```sh
node --experimental-strip-types agent.ts
node -p "require('./agent.json').run.runId"
```

Two more `note:` lines, then `done:`. `notes.txt` holds each colour once — the
note the first process wrote was not written again — and the run id is the one
you printed before the kill. The second process did not start a run; it resumed
the first one.

Here is what happened. Every transition of the first process was saved to
`agent.json` before its effects ran, so the kill left a Model that already held
the first note's outcome and was waiting on the next model call. `agent.run`
with a `Store` reads what it is handed: an empty Store starts a run, a finished
Model is returned as it is, and a Model caught mid-run is booted at its one
outstanding effect. That effect was a model call, so the model was called with
the transcript the first process built, and the tool was not — its outcome was
already data in the Model.

That is the whole durability story for an agent, and it is the same one the
[first lesson](./build-your-first-machine.md) showed for a download: the Model is
plain data, the `Store` is the one seam that persists it, and the reducer never
knew it was interrupted. To run this exact agent inside a Cloudflare Durable
Object, where the eviction is the platform's rather than your `Ctrl-C`, see
[Deploy an agent to a Durable Object](../how-to/deploy-an-agent-to-a-durable-object.md).
