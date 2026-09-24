/**
 * The model-port recipe's compile-and-run gate (#337).
 *
 * `docs/how-to/supply-the-agents-model.md` hands the reader an adapter to
 * paste. A pasteable adapter that nothing compiles rots against `AgentTurn`
 * silently, and the field most likely to rot is the one a reader would drop:
 * `provider`, whose loss no type error announces.
 *
 * So every `ts` block on the page lives HERE, as real TypeScript in the test
 * program (`tsconfig.test.json`, gated in CI as `typecheck:test`), and the
 * tests below assert the page shows each `#region` verbatim. Both adapters are
 * then driven against a stubbed `fetch`, so the chat-completions mapping is
 * proven to run, and the page's `async` claim is checked against `defineAgent`.
 *
 * `openai` is a devDependency and only this file imports it: the package's
 * `dependencies`, `peerDependencies` and export map are untouched.
 */

// biome-ignore-all assist/source/organizeImports: the `#region` markers below
// pin import blocks the page reproduces verbatim; sorting the harness's imports
// into them would move a marker and break the assertions this file is.
// biome-ignore-all lint/suspicious/noExportsInTest: the adapter is the artifact
// under test, and it is exported because the reader pastes it as a module.

import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { DriveFailedError } from "@demlik/tea";
import {
  type DefinedAgentState,
  PLAIN_MODEL_MISROUTE_REASON,
  tool,
} from "@demlik/tea/agent";

// The wiring region builds its client at import, and the client refuses to
// construct without a key — so the key the reader exports is set before it.
const tokenWasSet = vi.hoisted(() => {
  const was = process.env.CF_AIG_TOKEN !== undefined;
  process.env.CF_AIG_TOKEN ??= "test-token";
  return was;
});

// #region model
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
      messages: toParams(messages),
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
function toParams(
  messages: readonly AgentMessage[],
): ChatCompletionMessageParam[] {
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
            typeof m.content === "string" ? m.content : m.content.map(toPart),
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
        shown = [...shown, ...(m.parts ?? []).map(toPart)];
        break;
    }
  }
  if (shown.length > 0) sent.push({ role: "user", content: shown });
  return sent;
}

/** One tea content part as a chat-completions part. */
function toPart(p: ContentPart): ChatCompletionContentPart {
  switch (p.type) {
    case "text":
      return { type: "text", text: p.text };
    case "image":
      return {
        type: "image_url",
        image_url: { url: urlOf(p.mediaType, p.source) },
      };
    case "file":
      return {
        type: "file",
        file: { file_data: urlOf(p.mediaType, p.source) },
      };
  }
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
// #endregion model

// #region streaming
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
      messages: toParams(messages),
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
// #endregion streaming

/** The tutorial's `note` tool, so the wiring block below compiles as shown. */
const note = tool(
  "note",
  {
    description: "Append one line to the notebook",
    input: z.object({ text: z.string() }),
    ok: z.object({ saved: z.boolean() }),
    err: [],
  },
  async (_args, _ctx, { ok }) => ok({ saved: true }),
);

// #region wire
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
// #endregion wire

const page = fileURLToPath(
  new URL("../../../docs/how-to/supply-the-agents-model.md", import.meta.url),
);
const self = fileURLToPath(import.meta.url);

/** The text between one region's markers, which is what the page shows. */
async function region(name: string): Promise<string> {
  const source = await readFile(self, "utf8");
  const body = source
    .split(`// #region ${name}\n`)[1]
    ?.split(`// #endregion ${name}\n`)[0];
  if (body === undefined)
    throw new Error(`the ${name} region markers are gone`);
  return body.trimEnd();
}

/** Every fenced ```ts block on the page, in page order. */
async function tsBlocks(): Promise<string[]> {
  const markdown = await readFile(page, "utf8");
  return [...markdown.matchAll(/```ts\n([\s\S]*?)```/g)].map((m) =>
    (m[1] ?? "").trimEnd(),
  );
}

const ENDPOINT: Endpoint = {
  baseURL: "https://gateway.test/compat",
  apiKey: "test-key",
  model: "openai/gpt-5",
};

/** Stub `fetch` with one canned response and record the request bodies it saw. */
function stubFetch(respond: () => Response): unknown[] {
  const bodies: unknown[] = [];
  vi.stubGlobal("fetch", async (_url: unknown, init?: RequestInit) => {
    bodies.push(JSON.parse(String(init?.body)));
    return respond();
  });
  return bodies;
}

const json = (body: unknown): Response =>
  new Response(JSON.stringify(body), {
    headers: { "content-type": "application/json" },
  });

const sse = (chunks: readonly unknown[]): Response =>
  new Response(
    [
      ...chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`),
      "data: [DONE]\n\n",
    ].join(""),
    { headers: { "content-type": "text/event-stream" } },
  );

const completion = (message: Record<string, unknown>) => ({
  id: "c1",
  object: "chat.completion",
  created: 0,
  model: "openai/gpt-5",
  choices: [{ index: 0, finish_reason: "stop", message }],
});

const chunk = (delta: Record<string, unknown>) => ({
  id: "c1",
  object: "chat.completion.chunk",
  created: 0,
  model: "openai/gpt-5",
  choices: [{ index: 0, finish_reason: null, delta }],
});

afterEach(() => {
  vi.unstubAllGlobals();
});

afterAll(() => {
  if (!tokenWasSet) delete process.env.CF_AIG_TOKEN;
});

describe("docs/how-to/supply-the-agents-model.md (#337)", () => {
  it("shows every compiled region verbatim, so the recipe cannot rot", async () => {
    const blocks = await tsBlocks();
    const regions = await Promise.all(
      ["model", "streaming", "wire"].map(region),
    );
    expect(blocks).toEqual(regions);
  });

  it("points at the tutorial's Anthropic adapter rather than copying it", async () => {
    const markdown = await readFile(page, "utf8");
    expect(markdown).toContain("../tutorial/build-a-durable-agent.md");
    expect(markdown).toContain("Give the agent a brain");
    expect(markdown).not.toContain("@anthropic-ai/sdk");
  });

  it("maps a completion's tool calls onto a turn, and the endpoint's extras into provider", async () => {
    const details = [{ type: "reasoning.encrypted", data: "sig" }];
    stubFetch(() =>
      json(
        completion({
          role: "assistant",
          content: null,
          refusal: null,
          tool_calls: [
            {
              id: "call_1",
              type: "function",
              function: { name: "note", arguments: '{"text":"red"}' },
            },
          ],
          reasoning_details: details,
        }),
      ),
    );
    const turn = await openaiCompatible(ENDPOINT, [note])([
      { role: "user", content: "go" },
    ]);
    expect(turn).toEqual({
      content: "",
      toolCalls: [{ callId: "call_1", name: "note", args: { text: "red" } }],
      provider: { reasoning_details: details },
    });
  });

  it("leaves provider off a turn whose endpoint added nothing", async () => {
    stubFetch(() =>
      json(completion({ role: "assistant", content: "done", refusal: null })),
    );
    const turn = await openaiCompatible(
      ENDPOINT,
      [],
    )([{ role: "user", content: "go" }]);
    expect(turn).toEqual({ content: "done", toolCalls: [] });
  });

  it("sends the transcript as chat-completions messages, replaying provider unchanged", async () => {
    const bodies = stubFetch(() =>
      json(completion({ role: "assistant", content: "ok", refusal: null })),
    );
    await openaiCompatible(ENDPOINT, [note])([
      { role: "system", content: "be brief" },
      { role: "user", content: "go" },
      {
        role: "assistant",
        content: "",
        toolCalls: [{ callId: "call_1", name: "note", args: { text: "red" } }],
        provider: { reasoning_details: ["sig"] },
      },
      {
        role: "tool",
        callId: "call_1",
        name: "note",
        outcome: { kind: "ok", result: { saved: true } },
      },
    ]);
    const sent = bodies[0] as {
      messages: unknown[];
      tools: { function: { name: string; parameters: unknown } }[];
    };
    expect(sent.messages).toEqual([
      { role: "system", content: "be brief" },
      { role: "user", content: "go" },
      {
        reasoning_details: ["sig"],
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: "call_1",
            type: "function",
            function: { name: "note", arguments: '{"text":"red"}' },
          },
        ],
      },
      {
        role: "tool",
        tool_call_id: "call_1",
        content: '{"kind":"ok","result":{"saved":true}}',
      },
    ]);
    expect(sent.tools[0]?.function.name).toBe("note");
    expect(sent.tools[0]?.function.parameters).toMatchObject({
      type: "object",
      properties: { text: { type: "string" } },
    });
  });

  it("sends user parts as content parts, and a tool's parts after the tool run", async () => {
    const bodies = stubFetch(() =>
      json(completion({ role: "assistant", content: "ok", refusal: null })),
    );
    const shot = {
      type: "image" as const,
      mediaType: "image/png",
      source: { type: "base64" as const, data: "AAAA" },
    };
    await openaiCompatible(ENDPOINT, [note])([
      {
        role: "user",
        content: [
          { type: "text", text: "read this" },
          {
            type: "file",
            mediaType: "application/pdf",
            source: { type: "bytes", data: new Uint8Array([1, 2, 3]) },
          },
        ],
      },
      {
        role: "assistant",
        content: "",
        toolCalls: [
          { callId: "call_1", name: "note", args: { text: "a" } },
          { callId: "call_2", name: "note", args: { text: "b" } },
        ],
      },
      {
        role: "tool",
        callId: "call_1",
        name: "note",
        outcome: { kind: "ok", result: { saved: true } },
        parts: [shot],
      },
      {
        role: "tool",
        callId: "call_2",
        name: "note",
        outcome: { kind: "ok", result: { saved: true } },
      },
    ]);
    const sent = (bodies[0] as { messages: { role: string }[] }).messages;
    expect(sent[0]).toEqual({
      role: "user",
      content: [
        { type: "text", text: "read this" },
        {
          type: "file",
          file: { file_data: "data:application/pdf;base64,AQID" },
        },
      ],
    });
    expect(sent.map((m) => m.role)).toEqual([
      "user",
      "assistant",
      "tool",
      "tool",
      "user",
    ]);
    expect(sent[2]).toEqual({
      role: "tool",
      tool_call_id: "call_1",
      content: "The note result is in the next user message.",
    });
    expect(sent[4]).toEqual({
      role: "user",
      content: [
        { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } },
      ],
    });
  });

  it("streams text to onChunk and joins tool-call fragments by index", async () => {
    stubFetch(() =>
      sse([
        chunk({ role: "assistant", content: "Sav" }),
        chunk({ content: "ing." }),
        chunk({
          tool_calls: [
            {
              index: 0,
              id: "call_1",
              type: "function",
              function: { name: "note", arguments: '{"te' },
            },
          ],
        }),
        chunk({
          tool_calls: [{ index: 0, function: { arguments: 'xt":"red"}' } }],
        }),
      ]),
    );
    const deltas: string[] = [];
    const turn = await openaiCompatibleStreaming(ENDPOINT, [note])(
      [{ role: "user", content: "go" }],
      { onChunk: (c) => deltas.push(c.text) },
    );
    expect(deltas).toEqual(["Sav", "ing."]);
    expect(turn).toEqual({
      content: "Saving.",
      toolCalls: [{ callId: "call_1", name: "note", args: { text: "red" } }],
    });
  });

  it("fails a run whose promise-returning model is not declared async, naming plainModel", async () => {
    const bare = (_messages: readonly AgentMessage[]) =>
      Promise.resolve<AgentTurn>({ content: "done", toolCalls: [] });
    const failed = await defineAgent({
      model: bare,
      tools: [note],
      instructions: "",
    })
      .run("go")
      .catch((e: unknown) => e);
    expect(failed).toBeInstanceOf(DriveFailedError);
    const state = (failed as DriveFailedError<DefinedAgentState<typeof note>>)
      .state;
    expect(state.failure?.reason).toBe("llm");
    expect(JSON.stringify(state.failure)).toContain(
      PLAIN_MODEL_MISROUTE_REASON,
    );
  });

  it("runs the same function once it is declared async", async () => {
    const marked = async (_messages: readonly AgentMessage[]) =>
      Promise.resolve<AgentTurn>({ content: "done", toolCalls: [] });
    const final = await defineAgent({
      model: marked,
      tools: [note],
      instructions: "",
    }).run("go");
    expect(final.output?.content).toBe("done");
  });
});
