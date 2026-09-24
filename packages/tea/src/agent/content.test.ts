import { describe, expect, it } from "vitest";
import { z } from "zod";
import type { Store } from "../index";
import { memoryStore } from "../mem";
import {
  type AgentMessage,
  type AgentPrompt,
  type AgentTurn,
  type ContentPart,
  contentParts,
  type DefinedAgentState,
  defineAgent,
  FILE_OMITTED,
  IMAGE_OMITTED,
  omitMedia,
  renderPrompt,
  tool,
  toolRouter,
} from "./index";

// ---------------------------------------------------------------------------
// #330 — multimodal content parts. A `user` message's content is a string or
// parts; a tool declares `content` and its `ok` result reaches the model as
// parts on the `tool` message, beside the outcome, across a Store round-trip.
// Compaction hands the summarizer text placeholders for images and files.
// ---------------------------------------------------------------------------

const JPEG = "/9j/4AAQSkZJRgABAQ"; // a base64 JPEG header — the bytes never matter here
const INSTRUCTIONS = "You audit a page by looking at it.";
const INPUT = "Is the sign-in button visible?";

const screenshot = tool(
  "screenshot",
  {
    description: "Capture the page as a JPEG.",
    input: z.object({}),
    ok: z.object({ jpeg: z.string(), width: z.number() }),
    err: ["blank"],
    content: (r) => [
      { type: "text", text: `A ${r.width}px-wide capture.` },
      {
        type: "image",
        mediaType: "image/jpeg",
        source: { type: "base64", data: r.jpeg },
      },
    ],
  },
  async (_args, ctx: Page, { ok, fail }) => {
    ctx.shots.push("shot");
    return ctx.blank
      ? fail({ _tag: "blank" })
      : ok({ jpeg: JPEG, width: 1280 });
  },
);

/** The page a screenshot is taken of; `shots` counts the handler's runs. */
interface Page {
  readonly blank: boolean;
  readonly shots: string[];
}
const page = (blank = false): Page => ({ blank, shots: [] });

const SHOT_PARTS: readonly ContentPart[] = [
  { type: "text", text: "A 1280px-wide capture." },
  {
    type: "image",
    mediaType: "image/jpeg",
    source: { type: "base64", data: JPEG },
  },
];

const LOOK: AgentTurn = {
  content: "let me look",
  toolCalls: [{ callId: "s1", name: "screenshot", args: {} }],
};
const LOOK_AGAIN: AgentTurn = {
  content: "once more",
  toolCalls: [{ callId: "s2", name: "screenshot", args: {} }],
};
const ANSWER: AgentTurn = { content: "Yes, top right.", toolCalls: [] };

/** A model that plays `turns` for brain calls, answers summaries, and records both. */
function scripted(turns: readonly AgentTurn[]) {
  const brain: (readonly AgentMessage[])[] = [];
  const summarize: (readonly AgentMessage[])[] = [];
  let i = 0;
  const model = async (messages: readonly AgentMessage[]) => {
    const head = messages[0];
    if (head?.role === "system" && head.content !== INSTRUCTIONS) {
      summarize.push(messages);
      return { content: "SUMMARY", toolCalls: [] };
    }
    brain.push(messages);
    const turn = turns[i] ?? ANSWER;
    i += 1;
    return turn;
  };
  return { model, brain, summarize };
}

describe("ContentPart — the provider-neutral part shape", () => {
  it("a user message holds a string or parts; a part's source is data or a URL, never both", () => {
    const text: AgentMessage = { role: "user", content: INPUT };
    const parts: AgentMessage = {
      role: "user",
      content: [
        { type: "text", text: INPUT },
        {
          type: "image",
          mediaType: "image/png",
          source: { type: "url", url: "https://example.com/a.png" },
        },
        {
          type: "file",
          mediaType: "application/pdf",
          source: { type: "bytes", data: new Uint8Array([37, 80, 68, 70]) },
        },
      ],
    };
    const bad: ContentPart = {
      type: "image",
      mediaType: "image/png",
      // @ts-expect-error — a source is one of base64 / bytes / url, not a mix
      source: { type: "url", url: "https://example.com/a.png", data: "AAAA" },
    };
    expect(text.role).toBe("user");
    expect(parts.role).toBe("user");
    expect(bad.type).toBe("image");
  });

  it("contentParts reads a string as one text part and passes parts through", () => {
    expect(contentParts(INPUT)).toEqual([{ type: "text", text: INPUT }]);
    expect(contentParts(SHOT_PARTS)).toBe(SHOT_PARTS);
  });

  it("omitMedia turns images and files into placeholders and leaves text alone", () => {
    const text = { type: "text", text: "keep me" } as const;
    const out = omitMedia([
      text,
      SHOT_PARTS[1] as ContentPart,
      {
        type: "file",
        mediaType: "application/pdf",
        source: { type: "url", url: "https://example.com/a.pdf" },
      },
    ]);
    expect(out).toEqual([
      text,
      { type: "text", text: IMAGE_OMITTED },
      { type: "text", text: FILE_OMITTED },
    ]);
    expect(out[0]).toBe(text);
    expect(IMAGE_OMITTED).toBe("[image omitted]");
  });
});

describe("a tool's content parts reach the model as parts (#330)", () => {
  it("the next brain call reads the screenshot as an image part beside the outcome", async () => {
    const { model, brain } = scripted([LOOK, ANSWER]);
    const final = await defineAgent({
      model,
      tools: [screenshot],
      instructions: INSTRUCTIONS,
    }).run(INPUT, { ctx: page(), store: memoryStore() });

    expect(final.run.phase).toBe("done");
    expect(brain[1]?.at(-1)).toEqual({
      role: "tool",
      callId: "s1",
      name: "screenshot",
      outcome: { kind: "ok", result: { jpeg: JPEG, width: 1280 } },
      parts: SHOT_PARTS,
    });
  });

  it("a failed call carries no parts; the model reads the failure as the outcome", async () => {
    const { model, brain } = scripted([LOOK, ANSWER]);
    await defineAgent({
      model,
      tools: [screenshot],
      instructions: INSTRUCTIONS,
    }).run(INPUT, { ctx: page(true) });

    const message = brain[1]?.at(-1);
    expect(message).toMatchObject({
      role: "tool",
      outcome: { kind: "error", _tag: "blank" },
    });
    expect(message).not.toHaveProperty("parts");
  });

  it("a tool that declares no content renders exactly as before — no parts key", () => {
    const plain = tool(
      "plain",
      {
        description: "No parts.",
        input: z.object({}),
        ok: z.object({ n: z.number() }),
        err: [],
      },
      async (_a, _c, { ok }) => ok({ n: 1 }),
    );
    const call = { callId: "p1", name: "plain", args: {} };
    const outcome = { kind: "ok" as const, result: { n: 1 } };
    const prompt: AgentPrompt<unknown> = {
      instructions: null,
      input: null,
      conversation: {
        turns: [{ content: "", toolCalls: [call] }],
        toolRecords: [{ call, outcome, turn: 0 }],
        turnCount: 1,
        awaiting: { kind: "llm" },
        contextTokens: null,
      },
    };
    const [, message] = renderPrompt(prompt, toolRouter([plain]).partsOf);
    expect(message).toEqual({
      role: "tool",
      callId: "p1",
      name: "plain",
      outcome,
    });
    expect(plain.content).toBeNull();
  });

  it("is durable: a run parked after the screenshot resumes from the Store and still shows the image", async () => {
    const ctx = page();
    const parked = await parkAfterFirstTool(ctx);
    expect(ctx.shots).toHaveLength(1);

    const second = scripted([ANSWER]);
    const final = await defineAgent({
      model: second.model,
      tools: [screenshot],
      instructions: INSTRUCTIONS,
    }).run(INPUT, { ctx, store: memoryStore(parked), runId: "run-2" });

    expect(final.run.phase).toBe("done");
    expect(final.run.phase === "done" && final.run.runId).toBe("run-1");
    // The tool did not re-run; its image is re-derived from the stored result.
    expect(ctx.shots).toHaveLength(1);
    expect(second.brain).toHaveLength(1);
    expect(second.brain[0]?.at(-1)).toEqual({
      role: "tool",
      callId: "s1",
      name: "screenshot",
      outcome: { kind: "ok", result: { jpeg: JPEG, width: 1280 } },
      parts: SHOT_PARTS,
    });
  });

  it("a checkpoint mid-brain-call holds the image no more often than the Model without its outbox (#354)", async () => {
    const parked = await parkAfterFirstTool(page());
    // The saved Model is the one whose transition issued the brain call…
    expect(parked.lifecycle.map((note) => note.kind)).toContain(
      "brain_started",
    );
    // …and the request it issued, screenshot included, is on the brain slice.
    expect(JSON.stringify(parked.resilience)).toContain(JPEG);

    const copies = (model: unknown) =>
      JSON.stringify(model).split(JPEG).length - 1;
    expect(copies(parked)).toBeGreaterThan(0);
    expect(copies(parked)).toBe(copies({ ...parked, lifecycle: [] }));
  });
});

/**
 * Run 1 until the Store is handed the Model with the first tool outcome folded
 * and the next brain call open, copy those bytes across a JSON boundary (the
 * shape a real Store holds), then let run 1 finish so its runtime drains.
 */
async function parkAfterFirstTool(
  ctx: Page,
): Promise<DefinedAgentState<typeof screenshot>> {
  type S = DefinedAgentState<typeof screenshot>;
  const first = scripted([LOOK]);
  let release: (turn: AgentTurn) => void = () => {};
  const held = new Promise<AgentTurn>((resolve) => {
    release = resolve;
  });
  let park: (state: S) => void = () => {};
  const parkedAt = new Promise<S>((resolve) => {
    park = resolve;
  });
  const live = memoryStore<S>();
  const store: Store<S> = {
    ...live,
    save: async (state) => {
      await live.save(state);
      if (
        state.conversation?.awaiting.kind === "llm" &&
        state.conversation.toolRecords.length === 1
      ) {
        park(JSON.parse(JSON.stringify(state)) as S);
      }
    },
  };
  const firstRun = defineAgent({
    model: async (messages: readonly AgentMessage[]) =>
      first.brain.length === 0 ? first.model(messages) : held,
    tools: [screenshot],
    instructions: INSTRUCTIONS,
  }).run(INPUT, { ctx, store, runId: "run-1" });
  const parked = await parkedAt;
  release(ANSWER);
  await firstRun;
  return parked;
}

describe("back-compat: a Model persisted with string content (#330)", () => {
  it("loads, resumes, and its user content reads as a single text part", async () => {
    // What a Store holds is the Model, and the Model keeps strings and results,
    // never parts: parts are derived at render. So the persisted bytes are the
    // shape 0.17 wrote, and a resume over them is the back-compat path.
    const parked = await parkAfterFirstTool(page());
    expect(JSON.stringify(parked)).not.toContain('"parts"');
    expect(JSON.stringify(parked)).not.toContain('"image"');

    const second = scripted([ANSWER]);
    const final = await defineAgent({
      model: second.model,
      tools: [screenshot],
      instructions: INSTRUCTIONS,
    }).run(INPUT, { ctx: page(), store: memoryStore(parked) });

    expect(final.run.phase).toBe("done");
    const user = second.brain[0]?.find((m) => m.role === "user");
    expect(user).toEqual({ role: "user", content: INPUT });
    expect(user?.role === "user" && contentParts(user.content)).toEqual([
      { type: "text", text: INPUT },
    ]);
  });
});

describe("compaction folds images and files to placeholders (#330)", () => {
  it("the summarizer reads [image omitted]; the text parts it gets are untouched", async () => {
    const { model, brain, summarize } = scripted([LOOK, LOOK_AGAIN, ANSWER]);
    const final = await defineAgent({
      model,
      tools: [screenshot],
      instructions: INSTRUCTIONS,
      compaction: { afterTurns: 2 },
    }).run(INPUT, { ctx: page() });

    expect(final.run.phase).toBe("done");
    expect(summarize).toHaveLength(1);
    const tools = (summarize[0] ?? []).filter((m) => m.role === "tool");
    expect(tools).toHaveLength(2);
    for (const m of tools) {
      expect(m.role === "tool" && m.parts).toEqual([
        { type: "text", text: "A 1280px-wide capture." },
        { type: "text", text: IMAGE_OMITTED },
      ]);
    }
    // The live brain call before the fold still saw the image.
    expect(brain[1]?.at(-1)).toMatchObject({ parts: SHOT_PARTS });
    // After the fold the summary stands in for both turns.
    expect(brain[2]?.at(-1)).toEqual({
      role: "assistant",
      content: "SUMMARY",
      toolCalls: [],
    });
  });
});
