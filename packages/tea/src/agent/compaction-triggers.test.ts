import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  type AgentMessage,
  type AgentTurn,
  type ContentPart,
  type DefineAgentCompaction,
  type DefineAgentConfig,
  defineAgent,
  IMAGE_OMITTED,
  tool,
} from "./index";

const INSTRUCTIONS = "Inspect the images.";
const image = (
  source: Extract<ContentPart, { type: "image" }>["source"],
): ContentPart => ({
  type: "image",
  mediaType: "image/png",
  source,
});
const pixel = image({ type: "base64", data: "YQ==" });
const url = image({ type: "url", url: "https://example.com/image.png" });
const call = (id: number) => ({ callId: `c${id}`, name: "capture", args: {} });
const turn = (id: number, input = 10, output = 1): AgentTurn => ({
  content: `turn ${id}`,
  toolCalls: [call(id)],
  usage: { inputTokens: input, outputTokens: output, cachedInputTokens: input },
});

async function scenario(
  compaction: DefineAgentCompaction,
  turns: readonly AgentTurn[] = [turn(1), turn(2)],
  batches: readonly (readonly ContentPart[])[] = [[pixel], [pixel]],
  imageBudget = Number.POSITIVE_INFINITY,
  media?: {
    readonly retain: { readonly ceiling: number; readonly floor: number };
  },
  checkAtEnd = false,
) {
  let batch = 0;
  const capture = tool(
    "capture",
    {
      description: "Capture content",
      input: z.object({}),
      ok: z.object({
        batch: z.number(),
        hiddenImage: z.object({
          type: z.literal("image"),
          mediaType: z.string(),
          source: z.object({ type: z.literal("base64"), data: z.string() }),
        }),
      }),
      err: [],
      content: (result) => batches[result.batch] ?? [],
    },
    async (_args, _ctx: { readonly task: string }, { ok }) =>
      ok({
        batch: batch++,
        hiddenImage: {
          type: "image",
          mediaType: "image/png",
          source: { type: "base64", data: "YQ==" },
        },
      }),
  );
  const brain: (readonly AgentMessage[])[] = [];
  const summaries: (readonly AgentMessage[])[] = [];
  const model = async (
    messages: readonly AgentMessage[],
  ): Promise<AgentTurn> => {
    const head = messages[0];
    if (head?.role === "system" && head.content !== INSTRUCTIONS) {
      summaries.push(messages);
      return { content: "SUMMARY", toolCalls: [] };
    }
    const images = messages
      .flatMap((m) => (m.role === "tool" ? (m.parts ?? []) : []))
      .filter((part) => part.type === "image");
    if (images.length > imageBudget)
      throw new Error("image budget exceeded before brain call");
    const next = turns[brain.length];
    brain.push(messages);
    return next ?? { content: "done", toolCalls: [] };
  };
  const agent = defineAgent({
    model,
    tools: [capture],
    instructions: INSTRUCTIONS,
    compaction: checkAtEnd
      ? {
          get afterImageBytes() {
            return brain.length >= turns.length
              ? (compaction.afterImageBytes ?? Infinity)
              : Infinity;
          },
          get afterImageCount() {
            return brain.length >= turns.length
              ? (compaction.afterImageCount ?? Infinity)
              : Infinity;
          },
        }
      : compaction,
    media,
  });
  const result = await agent.run("inspect", { ctx: { task: "inspect" } });
  expect(result.output?.content).toBe("done");
  return { brain, summaries };
}

const BELOW = {
  afterTurns: 100,
  afterContextTokens: 1_000,
  afterInputTokens: 1_000,
  afterImageBytes: 1_000,
  afterImageCount: 100,
};

describe("independent compaction thresholds through defineAgent.run", () => {
  it.each([
    ["turns", { afterTurns: 2 }],
    ["context", { afterContextTokens: 11 }],
    ["input including cached input", { afterInputTokens: 9 }],
    ["image bytes", { afterImageBytes: 1 }],
    ["image count equality", { afterImageCount: 2 }],
  ] as const)("%s fires while every other configured row is false", async (_name, trigger) => {
    const { brain, summaries } = await scenario({ ...BELOW, ...trigger });
    expect(summaries).toHaveLength(1);
    expect(
      brain[2]?.filter((m) => m.role === "assistant").map((m) => m.content),
    ).toEqual(["SUMMARY"]);
    expect(brain[2]?.filter((m) => m.role === "tool")).toEqual([]);
  });

  it.each([
    ["all false", BELOW, [turn(1), turn(2)]],
    [
      "strict input equality and output-only growth",
      { afterInputTokens: 10 },
      [turn(1, 10, 5_000), turn(2, 10, 9_000)],
    ],
    ["strict byte equality", { afterImageBytes: 2 }, [turn(1), turn(2)]],
  ] as const)("%s leaves the transcript intact", async (_name, knob, turns) => {
    const { brain, summaries } = await scenario(knob, turns);
    expect(summaries).toHaveLength(0);
    expect(brain[2]?.filter((m) => m.role === "tool")).toHaveLength(2);
  });

  it("two true thresholds request exactly one summary", async () => {
    const { summaries } = await scenario({ afterTurns: 2, afterImageCount: 2 });
    expect(summaries).toHaveLength(1);
  });

  it.each([
    { afterInputTokens: 9 },
    { afterImageBytes: 1 },
    { afterImageCount: 2 },
  ])("works alone: %j", async (knob) => {
    const { summaries } = await scenario(knob);
    expect(summaries).toHaveLength(1);
  });

  it("counts decoded padding, byte views and repeats, excluding files, text and opaque data", async () => {
    const bytes = new Uint8Array(100).subarray(10, 12);
    const parts: readonly ContentPart[] = [
      { type: "text", text: "image" },
      {
        type: "file",
        mediaType: "application/pdf",
        source: { type: "bytes", data: new Uint8Array(100) },
      },
      pixel,
      pixel,
      image({ type: "base64", data: "YWI=" }),
      image({ type: "bytes", data: bytes }),
      url,
    ];
    // Each result holds five image occurrences and six decoded bytes.
    const equal = await scenario({ afterImageBytes: 12 }, undefined, [
      parts,
      parts,
    ]);
    expect(equal.summaries).toHaveLength(0);
    const crossed = await scenario({ afterImageBytes: 11 }, undefined, [
      parts,
      parts,
    ]);
    expect(crossed.summaries).toHaveLength(1);
    const counted = await scenario({ afterImageCount: 10 }, undefined, [
      parts,
      parts,
    ]);
    expect(counted.summaries).toHaveLength(1);
    expect(
      counted.summaries[0]
        ?.flatMap((m) => (m.role === "tool" ? (m.parts ?? []) : []))
        .filter((p) => p.type === "text" && p.text === IMAGE_OMITTED),
    ).toHaveLength(10);
  });

  it("URL images have count but zero held bytes, without usage", async () => {
    const noUsage = [1, 2].map((id) => ({
      content: "look",
      toolCalls: [call(id)],
      provider: { image: pixel },
    }));
    const bytes = await scenario(
      { afterImageBytes: 0, afterInputTokens: 0 },
      noUsage,
      [[url], [url]],
    );
    expect(bytes.summaries).toHaveLength(0);
    const count = await scenario(
      { afterImageCount: 2, afterInputTokens: 0 },
      noUsage,
      [[url], [url]],
    );
    expect(count.summaries).toHaveLength(1);
  });

  it("recounts retained images and folds a crossing batch before a budgeted brain request", async () => {
    const { brain, summaries } = await scenario(
      { afterImageCount: 3, keepTurns: 1 },
      [turn(1), turn(2), turn(3), turn(4), turn(5)],
      [[pixel], [pixel], [pixel], [pixel], [pixel]],
      2,
    );
    expect(summaries).toHaveLength(2);
    expect(brain[3]?.filter((m) => m.role === "tool")).toHaveLength(1);
    expect(brain[4]?.filter((m) => m.role === "tool")).toHaveLength(2);
    expect(brain[5]?.filter((m) => m.role === "tool")).toHaveLength(1);
  });

  it("missing usage clears an earlier input reading", async () => {
    const { summaries } = await scenario({ afterInputTokens: 10 }, [
      turn(1, 20),
      { content: "no usage", toolCalls: [call(2)] },
    ]);
    expect(summaries).toHaveLength(0);
  });

  it("retained pre-fold input usage waits for a fresh brain reading", async () => {
    const { brain, summaries } = await scenario(
      { afterInputTokens: 10, keepTurns: 2 },
      [turn(1, 1), turn(2, 1), turn(3, 1), turn(4, 20), turn(5, 1)],
      [],
    );
    expect(summaries).toHaveLength(1);
    expect(brain[4]?.filter((m) => m.role === "assistant")).toHaveLength(3);
    expect(brain[5]?.filter((m) => m.role === "assistant")).toHaveLength(4);
  });
});

describe("tool image retention", () => {
  const media = { retain: { ceiling: 8, floor: 4 } };
  const imagesOf = (messages: readonly AgentMessage[]) =>
    messages
      .flatMap((m) => (m.role === "tool" ? (m.parts ?? []) : []))
      .filter((p) => p.type === "image");

  it("drops old image records in steps, preserving text and the prefix between drops", async () => {
    const { brain } = await scenario(
      BELOW,
      Array.from({ length: 13 }, (_, i) => turn(i + 1)),
      Array.from({ length: 13 }, () => [
        { type: "text", text: "caption" },
        pixel,
      ]),
      Infinity,
      media,
    );
    expect(brain.slice(1).map((messages) => imagesOf(messages).length)).toEqual(
      [1, 2, 3, 4, 5, 6, 7, 4, 5, 6, 7, 4, 5],
    );
    expect(brain[9]?.slice(0, brain[8]?.length)).toEqual(brain[8]);
    expect(brain[8]?.filter((m) => m.role === "tool")[0]?.parts).toEqual([
      { type: "text", text: "caption" },
    ]);
  });
});

describe("visible image compaction facts", () => {
  const media = { retain: { ceiling: 8, floor: 4 } };
  const emptyTurn: AgentTurn = { content: "context", toolCalls: [] };

  it.each(
    Array.from({ length: 21 }, (_, n) => n),
  )("agrees with rendered count and bytes at %i records", async (n) => {
    const turns = [
      turn(-2),
      turn(-1),
      ...Array.from({ length: n }, (_, i) => turn(i)),
    ];
    const batches = [
      [],
      [],
      ...Array.from({ length: n }, (_, i) => [
        image({ type: "bytes", data: new Uint8Array(i + 1) }),
        url,
      ]),
    ];
    const baseline = await scenario(BELOW, turns, batches, Infinity, media);
    const parts =
      baseline.brain
        .at(-1)
        ?.flatMap((m) => (m.role === "tool" ? (m.parts ?? []) : [])) ?? [];
    const images = parts.filter((p) => p.type === "image");
    const bytes = images.reduce(
      (sum, p) =>
        sum + (p.source.type === "bytes" ? p.source.data.byteLength : 0),
      0,
    );
    // Arm only at the final transcript, so earlier sawtooth peaks cannot fold.
    for (const [knob, expected] of [
      [{ afterImageCount: images.length + 1 }, 0],
      [{ afterImageCount: images.length }, 1],
      [{ afterImageBytes: bytes }, 0],
      ...(bytes > 0 ? [[{ afterImageBytes: bytes - 1 }, 1] as const] : []),
    ] as const) {
      const result = await scenario(
        knob,
        turns,
        batches,
        Infinity,
        media,
        true,
      );
      expect(result.summaries).toHaveLength(expected);
    }
  });

  it("folds once at screenshot 19 when the visible bytes first exceed 6 MiB", async () => {
    const mib = 1024 * 1024;
    const batches = Array.from({ length: 19 }, (_, i) => [
      image({ type: "bytes", data: new Uint8Array(i < 13 ? mib / 2 : mib) }),
    ]);
    const result = await scenario(
      { afterImageBytes: 6 * mib },
      Array.from({ length: 19 }, (_, i) => turn(i)),
      batches,
      Infinity,
      media,
    );
    expect(result.summaries).toHaveLength(1);
    expect(result.brain[18]?.filter((m) => m.role === "tool")).toHaveLength(18);
    expect(result.brain[19]?.filter((m) => m.role === "tool")).toHaveLength(0);
    expect(
      result.summaries[0]
        ?.flatMap((m) => (m.role === "tool" ? (m.parts ?? []) : []))
        .filter((p) => p.type === "text" && p.text === IMAGE_OMITTED),
    ).toHaveLength(7);
    expect(
      result.summaries[0]?.filter((m) => m.role === "tool")[0],
    ).not.toHaveProperty("parts");
  });

  it("selects the window before slicing the summary from the retained tail", async () => {
    const result = await scenario(
      { afterTurns: 8, keepTurns: 4 },
      Array.from({ length: 8 }, (_, i) => turn(i)),
      Array.from({ length: 8 }, () => [pixel]),
      Infinity,
      media,
    );
    expect(result.summaries).toHaveLength(1);
    const foldedTools = result.summaries[0]?.filter((m) => m.role === "tool");
    expect(foldedTools).toHaveLength(4);
    expect(foldedTools?.every((m) => m.parts === undefined)).toBe(true);
    expect(
      result.brain[8]
        ?.flatMap((m) => (m.role === "tool" ? (m.parts ?? []) : []))
        .filter((p) => p.type === "image"),
    ).toHaveLength(4);
  });

  it.each([
    { ceiling: 8, floor: 8 },
    { ceiling: 8, floor: 9 },
    { ceiling: 8, floor: 0 },
    { ceiling: 8.5, floor: 4 },
    { ceiling: Infinity, floor: 4 },
    { ceiling: 8, floor: NaN },
  ])("refuses invalid retention: %j", (retain) => {
    const config: DefineAgentConfig<never> = {
      model: async () => emptyTurn,
      tools: [],
      instructions: INSTRUCTIONS,
      media: { retain },
    };
    expect(() => defineAgent(config)).toThrow(
      "positive integers with floor < ceiling",
    );
  });
});
