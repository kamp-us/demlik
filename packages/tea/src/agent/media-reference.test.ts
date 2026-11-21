import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { fakeDoStorage } from "../__fixtures__/do-storage";
import { createAgentHost, doEventSourcedStore } from "../do";
import { run } from "../promise";
import {
  type AgentMessage,
  type AgentTurn,
  type ContentPart,
  defineAgent,
  resolveMediaParts,
  tool,
} from "./index";

const PIXELS = Array.from({ length: 25 }, (_, i) =>
  Buffer.alloc(96_000, i + 17).toString("base64"),
);

async function recordedRun(reference: boolean) {
  let capture = 0;
  const photo = tool(
    "photograph",
    {
      description: "Photograph the current scene",
      input: z.object({}),
      ok: z.object({ key: z.string(), byteLength: z.number() }),
      err: [],
      content: (r) => [
        {
          type: "image",
          mediaType: "image/jpeg",
          source: reference
            ? { type: "reference", key: r.key, byteLength: r.byteLength }
            : { type: "base64", data: PIXELS[Number(r.key)] ?? "" },
        },
      ],
    },
    async (_args, _ctx: { readonly task: string }, { ok }) =>
      ok({ key: String(capture++), byteLength: 96_000 }),
  );
  const requests: string[] = [];
  const resolve = vi.fn(async (source: { readonly key: string }) => ({
    type: "base64" as const,
    data: PIXELS[Number(source.key)] ?? "",
  }));
  const model = async (
    messages: readonly AgentMessage[],
  ): Promise<AgentTurn> => {
    const body = await Promise.all(
      messages.map(async (message) => {
        if (message.role !== "tool") return message;
        return {
          role: "tool",
          callId: message.callId,
          parts: await resolveMediaParts(message.parts ?? [], resolve),
        };
      }),
    );
    requests.push(JSON.stringify(body));
    return {
      content: `Observation ${capture}`,
      provider: {
        thinking: `Preserved thought ${capture}`,
        signature: `signature-${capture}`,
      },
      toolCalls:
        capture === 25
          ? []
          : [{ callId: `photo-${capture}`, name: "photograph", args: {} }],
    };
  };
  const ctx = { task: "photos" };
  const wired = defineAgent({
    instructions: "Inspect scenes",
    tools: [photo],
    model,
  }).machine("inspect");
  const { storage, backing } = fakeDoStorage();
  const journal = doEventSourcedStore(storage, wired.machine, ctx, {
    snapshotEvery: 10,
  });
  const host = createAgentHost({
    buildMachine: () => wired,
    ctx,
    store: journal.store,
    now: () => 1,
    run: (machine, options) => run(machine, options),
    toSseFrame: () => null,
  });
  try {
    const runtime = await host.runtime();
    await runtime.dispatch({ _tag: "agent_start", runId: "photos", at: 1 });
    const final = runtime.getState();
    expect(final.run.phase).toBe("done");
    expect(capture).toBe(25);
    expect(requests).toHaveLength(26);
    expect(JSON.stringify(final)).not.toContain(PIXELS[0]);
    for (const value of backing.values())
      expect(String(value)).not.toContain(PIXELS[0]);
    await runtime.stop();
    return { requests, resolve };
  } finally {
    await host.reset();
  }
}

it("keeps 25 append-only image turns out of durable state while preserving every provider request byte", async () => {
  const inline = await recordedRun(false);
  const referenced = await recordedRun(true);
  expect(referenced.requests).toEqual(inline.requests);
  expect(inline.resolve).not.toHaveBeenCalled();
  expect(referenced.resolve).toHaveBeenCalledTimes(325);
  for (const request of referenced.requests.slice(1))
    expect(request).toContain("signature-0");
});

describe("resolveMediaParts", () => {
  it("resolves images and files without mutating the stored parts", async () => {
    const parts = [
      { type: "text", text: "Keep this" },
      {
        type: "image",
        mediaType: "image/png",
        source: { type: "reference", key: "image", byteLength: 2 },
      },
      {
        type: "file",
        mediaType: "application/pdf",
        source: { type: "reference", key: "file", byteLength: 3 },
      },
      {
        type: "image",
        mediaType: "image/jpeg",
        source: { type: "base64", data: "YQ==" },
      },
    ] as const satisfies readonly ContentPart[];
    const before = JSON.stringify(parts);
    const resolve = vi.fn(async ({ key }: { readonly key: string }) => ({
      type: "url" as const,
      url: `https://example.test/${key}`,
    }));
    expect(await resolveMediaParts(parts, resolve)).toEqual([
      parts[0],
      {
        ...parts[1],
        source: { type: "url", url: "https://example.test/image" },
      },
      {
        ...parts[2],
        source: { type: "url", url: "https://example.test/file" },
      },
      parts[3],
    ]);
    expect(resolve).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(parts)).toBe(before);
  });

  it("preserves a resolver failure for the model call's retry policy", async () => {
    const failure = new Error("media unavailable");
    await expect(
      resolveMediaParts(
        [
          {
            type: "image",
            mediaType: "image/jpeg",
            source: { type: "reference", key: "missing", byteLength: 1 },
          },
        ],
        async () => {
          throw failure;
        },
      ),
    ).rejects.toBe(failure);
  });
});
