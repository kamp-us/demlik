# Supply the agent's model

`defineAgent` never calls a provider itself. Its `model` field takes one
function you write, and whatever client you call inside it is yours: a provider
SDK, a gateway, Effect AI. This page states the contract that function has to
meet, then gives one adapter that reaches every provider through an
OpenAI-compatible endpoint.

For Anthropic's Messages API called directly, use the adapter in the tutorial's
[Give the agent a brain](../tutorial/build-a-durable-agent.md#give-the-agent-a-brain)
section. It is the one to pick when you want Anthropic's signed thinking, which
the chat-completions shape has no field for.

## Meet the port contract

The port is `async (messages) => turn`. `messages` is the transcript tea
rendered from the durable Model: the `instructions` as a `system` message, the
run's input as a `user` message, then each earlier turn as an `assistant`
message followed by one `tool` message per call it made. The turn you resolve
is an `AgentTurn`, and four rules apply to it.

**Return the tool calls in `toolCalls`.** Each entry is
`{ callId, name, args }`: the id the provider minted, the tool's name (its
`cmdType`) and the parsed argument object. tea checks `args` against the tool's
`input` schema before the handler runs, so a malformed call becomes a failed
tool outcome and the run keeps going. An empty `toolCalls` ends the run, and
that turn's `content` is the answer.

**Round-trip `provider` unchanged.** `provider` is an optional slot for whatever
the provider needs sent back on the next request. Anthropic's signed `thinking`
blocks are the standard case: the API rejects a turn that drops them. tea stores
the value with the turn and hands it back, unread, on the `assistant` message
that replays that turn, so your adapter has to send it back exactly as it
stored it. If you rebuild the assistant message from `content` and `toolCalls`
alone, it compiles and passes a happy-path test, then fails the first time a
resume replays a reasoning turn. The value is written to the `Store` with the
rest of the Model, so it must be JSON-serializable. A
[compaction](../../../../.decisions/0004-agent-context-compaction.md) fold summarises
old turns into text and drops their `provider` with them. That is fine, because
nothing replays a summarised turn.

**Declare the function `async`.** tea's lower-level `ModelPort` accepts either
this function or a factory `(modelId) => Llm`, and both are one-argument
functions. The only runtime mark that tells them apart is the `AsyncFunction`
tag an `async` declaration carries, and that tag is what tea's internal
`asModelFactory` reads when it resolves the port. A plain function that returns
a promise, such as `(m) => client.chat(m)`, is read as a factory. The run then fails with
an `llm` failure whose reason is `PLAIN_MODEL_MISROUTE_REASON`. Declaring the
function `async`, or wrapping the call in `async (m) => client.chat(m)`, fixes
it. On `createAgent`, which takes the `ModelPort` directly, `plainModel(fn)` is
the explicit route: it lifts a promise-returning function into the factory
shape, so nothing depends on the tag.

**Take a second parameter to stream.** The streaming form is
`async (messages, { onChunk }) => turn`. `defineAgent` reads the function's
arity: two declared parameters mean streaming, one means plain. Call `onChunk`
with each text delta while the turn is in flight, then resolve the settled
turn. Deltas are never state: they are not journaled, not stored and not folded
into the Model, so a streamed run settles the same turn a plain one would.

## Adapt an OpenAI-compatible endpoint

Cloudflare AI Gateway and OpenRouter both expose one chat-completions endpoint
in front of many providers, so a single adapter over the `openai` SDK reaches
all of them. Install the SDK beside tea:

```sh
pnpm add openai
```

`openai` is your dependency, not tea's. tea neither imports it nor ships a
subpath for it.

```ts
// model.ts
import type {
  AgentMessage,
  AgentTurn,
  AnyToolDef,
  ContentPart,
  MediaSource,
} from "@demlik/tea/agent";
import OpenAI from "openai";
import type {
  ChatCompletionContentPart,
  ChatCompletionFunctionTool,
  ChatCompletionMessage,
  ChatCompletionMessageParam,
} from "openai/resources/chat/completions";
import { z } from "zod";

/** Where the adapter sends its requests, and which model answers them. */
export interface Endpoint {
  /** An OpenAI-compatible base URL: AI Gateway's `/compat`, OpenRouter's `/api/v1`. */
  readonly baseURL: string;
  readonly apiKey: string;
  /** The endpoint's own model id, provider-prefixed on a gateway. */
  readonly model: string;
}

/**
 * Any OpenAI-compatible chat-completions endpoint as tea's plain
 * `(messages) => turn` port. Which provider answers is the endpoint's business:
 * the same adapter reaches every model the gateway routes to.
 */
export function openaiCompatible(
  endpoint: Endpoint,
  tools: readonly AnyToolDef[],
) {
  const client = new OpenAI({
    baseURL: endpoint.baseURL,
    apiKey: endpoint.apiKey,
  });
  const declared = declaredTools(tools);
  return async (messages: readonly AgentMessage[]): Promise<AgentTurn> => {
    const completion = await client.chat.completions.create({
      model: endpoint.model,
      messages: await toParams(messages),
      tools: declared,
    });
    const message = completion.choices[0]?.message;
    if (message === undefined) throw new Error("the endpoint sent no choice");
    return turnOf(message);
  };
}

/** The tools as function declarations. The endpoint names calls; tea runs them. */
function declaredTools(
  tools: readonly AnyToolDef[],
): ChatCompletionFunctionTool[] {
  return tools.map((t) => ({
    type: "function",
    function: {
      name: t.cmdType,
      description: t.description,
      parameters: z.toJSONSchema(t.args as z.ZodType) as Record<
        string,
        unknown
      >,
    },
  }));
}

/** The endpoint's assistant message as a tea turn. */
function turnOf(message: ChatCompletionMessage): AgentTurn {
  // Every field the chat-completions shape names is mapped or dropped here.
  // Anything else is the endpoint's own addition (OpenRouter's
  // `reasoning_details`), so it rides in `provider` and `toParams` sends it
  // back unchanged next turn.
  const {
    role: _role,
    content,
    refusal,
    tool_calls,
    annotations: _annotations,
    audio: _audio,
    function_call: _functionCall,
    ...extras
  } = message;
  const turn: AgentTurn = {
    content: content ?? refusal ?? "",
    toolCalls: (tool_calls ?? []).flatMap((c) =>
      c.type === "function"
        ? [
            {
              callId: c.id,
              name: c.function.name,
              args: argsOf(c.function.arguments),
            },
          ]
        : [],
    ),
  };
  return Object.keys(extras).length === 0
    ? turn
    : { ...turn, provider: extras };
}

/** A tool call's JSON arguments. A no-argument call may send an empty string. */
function argsOf(json: string): Record<string, unknown> {
  return JSON.parse(json === "" ? "{}" : json) as Record<string, unknown>;
}

/** tea's transcript as chat-completions messages. */
async function toParams(
  messages: readonly AgentMessage[],
): Promise<ChatCompletionMessageParam[]> {
  const sent: ChatCompletionMessageParam[] = [];
  // A tool message carries text only, so the parts a tool shows the model (a
  // screenshot, say) wait here and follow the run of tool messages as one
  // user message: nothing may sit between a turn's tool calls and their results.
  let shown: ChatCompletionContentPart[] = [];
  for (const m of messages) {
    if (m.role !== "tool" && shown.length > 0) {
      sent.push({ role: "user", content: shown });
      shown = [];
    }
    switch (m.role) {
      case "system":
        sent.push({ role: "system", content: m.content });
        break;
      case "user":
        sent.push({
          role: "user",
          content:
            typeof m.content === "string"
              ? m.content
              : await Promise.all(m.content.map(toPart)),
        });
        break;
      case "assistant":
        sent.push({
          // The stored extras first, so the fields tea owns always win.
          ...(m.provider as Record<string, unknown> | undefined),
          role: "assistant",
          content: m.content === "" ? null : m.content,
          ...(m.toolCalls.length === 0
            ? {}
            : {
                tool_calls: m.toolCalls.map((c) => ({
                  id: c.callId,
                  type: "function" as const,
                  function: { name: c.name, arguments: JSON.stringify(c.args) },
                })),
              }),
        });
        break;
      case "tool":
        sent.push({
          role: "tool",
          tool_call_id: m.callId,
          content:
            m.parts === undefined
              ? JSON.stringify(m.outcome)
              : `The ${m.name} result is in the next user message.`,
        });
        shown = [...shown, ...(await Promise.all((m.parts ?? []).map(toPart)))];
        break;
    }
  }
  if (shown.length > 0) sent.push({ role: "user", content: shown });
  return sent;
}

/** One tea content part as a chat-completions part. */
async function toPart(p: ContentPart): Promise<ChatCompletionContentPart> {
  switch (p.type) {
    case "text":
      return { type: "text", text: p.text };
    case "image":
      return {
        type: "image_url",
        image_url: { url: urlOf(p.mediaType, p.source) },
      };
    case "file":
      // `file_data` takes the file's bytes, never a link.
      return {
        type: "file",
        file: { file_data: urlOf(p.mediaType, await downloaded(p.source)) },
      };
  }
}

/** A linked file's bytes, fetched; a source that already holds them, as it is. */
async function downloaded(source: MediaSource): Promise<MediaSource> {
  if (source.type !== "url") return source;
  const response = await fetch(source.url);
  if (!response.ok)
    throw new Error(`${source.url} answered ${response.status}`);
  return { type: "bytes", data: new Uint8Array(await response.arrayBuffer()) };
}

/** A part's source as chat completions reads it: a link, or a data URL. */
function urlOf(mediaType: string, source: MediaSource): string {
  switch (source.type) {
    case "url":
      return source.url;
    case "base64":
      return `data:${mediaType};base64,${source.data}`;
    case "bytes":
      return `data:${mediaType};base64,${Buffer.from(source.data).toString("base64")}`;
  }
}
```

Four details in this adapter carry the contract:

- `turnOf` maps the endpoint's `tool_calls` to `toolCalls`, parsing each call's
  JSON `arguments` into `args`. A refusal becomes the turn's `content`, so a run
  that ends on one still ends with the reason.
- Any field on the returned message that the chat-completions shape does not
  name goes into `provider`. OpenRouter returns `reasoning_details` there, for
  example, and wants it back on the next request. `toParams` spreads the stored
  value back into the assistant message, so it replays unchanged.
- A `user` message's content may be a list of parts, and a `tool` message may
  carry `parts` the tool wants the model to see, such as a screenshot. `toPart`
  sends images as `image_url` and files as `file`, with bytes as a data URL.
  An image may stay a link, but `file_data` takes only data, so `toPart`
  fetches a linked file and sends its bytes. Chat completions takes only text on a `tool` message, so a tool's parts
  follow the turn's tool results as one `user` message.
- A throw inside the function, including a `JSON.parse` failure on a truncated
  arguments string, fails that brain call. The agent's `retry` ladder then
  decides whether to call the model again.

This sample reads the tool schemas with `z.toJSONSchema`, so it assumes your
tools declare their `input` with Zod. A tool declared with another Standard
Schema library needs that library's JSON Schema export instead.

## Stream the turn

The streaming variant reuses `declaredTools`, `toParams` and `argsOf` from the
block above. Only the request and the assembly of the turn change:

```ts
import type { ModelStream } from "@demlik/tea/agent";

/**
 * The same adapter on tea's streaming port, `(messages, { onChunk }) => turn`.
 * Text deltas go to `onChunk` as they arrive; tool-call fragments are joined
 * by their `index`; the promise resolves the settled turn, which is the only
 * thing tea folds into the Model.
 */
export function openaiCompatibleStreaming(
  endpoint: Endpoint,
  tools: readonly AnyToolDef[],
) {
  const client = new OpenAI({
    baseURL: endpoint.baseURL,
    apiKey: endpoint.apiKey,
  });
  const declared = declaredTools(tools);
  return async (
    messages: readonly AgentMessage[],
    { onChunk }: ModelStream,
  ): Promise<AgentTurn> => {
    const stream = await client.chat.completions.create({
      model: endpoint.model,
      messages: await toParams(messages),
      tools: declared,
      stream: true,
    });
    let content = "";
    const calls: { id: string; name: string; json: string }[] = [];
    for await (const chunk of stream) {
      const delta = chunk.choices[0]?.delta;
      if (delta?.content) {
        content += delta.content;
        onChunk({ text: delta.content });
      }
      for (const part of delta?.tool_calls ?? []) {
        calls[part.index] ??= { id: "", name: "", json: "" };
        const call = calls[part.index];
        if (call === undefined) continue;
        if (part.id) call.id = part.id;
        if (part.function?.name) call.name = part.function.name;
        call.json += part.function?.arguments ?? "";
      }
    }
    return {
      content,
      toolCalls: calls.map((c) => ({
        callId: c.id,
        name: c.name,
        args: argsOf(c.json),
      })),
    };
  };
}
```

It replays text and tool calls but stores nothing in `provider`. If your
endpoint streams blocks it needs back, such as OpenRouter's
`reasoning_details`, collect them from the deltas into `provider`, or use the
plain adapter for that model.

Read the deltas off the run with the `onChunk` run option. See
[Show a run's progress while it runs](./show-a-run-in-progress.md).

## Wire it into the agent

Pass the adapter as `model`, next to the same tools you hand `defineAgent`. The
`note` tool here is the tutorial's. Against Cloudflare AI Gateway's
OpenAI-compatible endpoint, the model id is `<provider>/<model>`:

```ts
// agent.ts
import { defineAgent } from "@demlik/tea/agent";

const { CF_ACCOUNT_ID, CF_GATEWAY_ID, CF_AIG_TOKEN = "" } = process.env;

export const agent = defineAgent({
  model: openaiCompatible(
    {
      baseURL: `https://gateway.ai.cloudflare.com/v1/${CF_ACCOUNT_ID}/${CF_GATEWAY_ID}/compat`,
      apiKey: CF_AIG_TOKEN,
      model: "openai/gpt-5",
    },
    [note],
  ),
  tools: [note],
  instructions:
    "You keep a notebook. Save exactly one note per turn; when every fact is saved, answer in one line.",
});
```

To move providers, change `model`, for example `"anthropic/claude-sonnet-4-5"`
or `"google-ai-studio/gemini-2.5-flash"`. Nothing else in the program changes.
To use OpenRouter instead, set `baseURL` to `https://openrouter.ai/api/v1`, use
an OpenRouter key and OpenRouter's model ids.

## Notes

- Tool execution stays with tea. The endpoint only names the calls, and tea's
  fan-out runs them durably and folds each outcome back as a `tool` message.
- Every `ts` block on this page is compiled and asserted verbatim by
  `src/docs/how-to/supply-the-agents-model.test.ts`, which also runs both
  adapters against a stubbed endpoint.
