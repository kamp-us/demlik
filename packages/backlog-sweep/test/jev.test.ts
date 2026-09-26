import type { JevHttpReply, JevRequest } from "@demlik/tea/jev";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DETAIL_MAX_LENGTH,
  fetchPost,
  httpJevClient,
  JevAskError,
} from "../src/jev.js";
import { questions } from "../src/verdict.js";

function scripted(replies: readonly JevHttpReply[]) {
  const queue = [...replies];
  const seen: JevRequest[] = [];
  const post = async (request: JevRequest) => {
    seen.push(request);
    const next = queue.shift();
    if (next === undefined) throw new Error("no more replies");
    return next;
  };
  return { post, seen };
}

const noWait = async () => {};

describe("httpJevClient", () => {
  it("surfaces a 402's account error detail without retrying", async () => {
    const { post, seen } = scripted([
      {
        status: 402,
        body: {
          error: { message: "Credit limit reached", code: "payment_required" },
        },
      },
    ]);
    const ask = httpJevClient({
      questions,
      model: "jev-1",
      post,
      sleep: noWait,
    });
    const error = await ask({}).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(JevAskError);
    expect((error as JevAskError).detail).toBe(
      "Credit limit reached; payment_required",
    );
    expect((error as JevAskError).message).toContain(
      "Credit limit reached; payment_required",
    );
    expect(seen).toHaveLength(1);
  });

  it("bounds the detail an error body can put in the message", async () => {
    const { post } = scripted([
      { status: 402, body: { error: { message: "x".repeat(10_000) } } },
    ]);
    const ask = httpJevClient({
      questions,
      model: "jev-1",
      post,
      sleep: noWait,
    });
    const error = (await ask({}).catch((caught: unknown) => caught)) as
      | JevAskError
      | undefined;
    expect(error?.detail).toHaveLength(DETAIL_MAX_LENGTH);
  });
});

describe("fetchPost", () => {
  const apiKey = "sk-jev-test-3f9a1c";

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function respondWith(status: number, body: unknown) {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json(body, { status })),
    );
  }

  const echoes: ReadonlyArray<readonly [string, number, unknown]> = [
    [
      "an account error that quotes the key",
      402,
      {
        error: {
          message: `Credit limit reached for ${apiKey}`,
          code: `payment_required:${apiKey}`,
        },
      },
    ],
    [
      "an auth error that echoes the header",
      401,
      { error: `invalid authorization: Bearer ${apiKey}` },
    ],
    [
      "a rate limit that echoes the request, key and all",
      429,
      {
        message: `slow down ${apiKey}`,
        request: { headers: { authorization: `Bearer ${apiKey}` } },
        [apiKey]: [apiKey],
      },
    ],
  ];

  it.each(
    echoes,
  )("never lets the key into a thrown error: %s", async (_, status, body) => {
    respondWith(status, body);
    const ask = httpJevClient({
      questions,
      model: "jev-1",
      post: fetchPost(apiKey),
      sleep: noWait,
      retry: { baseMs: 1, factor: 2, capMs: 1, maxAttempts: 2, jitter: "none" },
    });
    const error = await ask({}).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(JevAskError);
    const thrown = error as JevAskError;
    expect(thrown.detail).toBeDefined();
    expect(thrown.message).not.toContain(apiKey);
    expect(JSON.stringify([thrown.reason, thrown.detail])).not.toContain(
      apiKey,
    );
  });

  it("keeps the rest of an error body readable around the redaction", async () => {
    respondWith(402, {
      error: {
        message: `Credit limit reached for ${apiKey}`,
        code: "payment_required",
      },
    });
    const reply = await fetchPost(apiKey)({
      state: {},
      model: "jev-1",
      questions,
    });
    expect(reply).toEqual({
      status: 402,
      body: {
        error: {
          message: "Credit limit reached for [redacted]",
          code: "payment_required",
        },
      },
    });
  });
});
