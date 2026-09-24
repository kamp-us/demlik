import type { JevHttpReply, JevRequest } from "@demlik/tea/jev";
import { describe, expect, it } from "vitest";
import { httpJevClient, JevAskError } from "../src/jev.js";
import { pairQuestions } from "../src/pairs/questions.js";

const ok: JevHttpReply = {
  status: 200,
  body: {
    model: "jev-1",
    answers: {
      verdict: {
        type: "choice",
        choice: "look_alike",
        confidence: 0.9,
        probabilities: {
          same_decision: 0.05,
          look_alike: 0.9,
          shared_helper: 0.05,
        },
      },
      business_rule: { type: "noul", noul: 0.2 },
    },
    usage: { input_tokens: 7, output_tokens: 1 },
  },
};

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
  it("backs off a 429 and returns the typed answer that follows", async () => {
    const { post, seen } = scripted([{ status: 429, body: {} }, ok]);
    const ask = httpJevClient({
      questions: pairQuestions,
      model: "jev-1",
      post,
      sleep: noWait,
    });
    const answer = await ask({ a: 1 });
    expect(answer.answers.verdict.choice).toBe("look_alike");
    expect(seen).toHaveLength(2);
    expect(seen[0]).toEqual({
      state: { a: 1 },
      model: "jev-1",
      questions: pairQuestions,
    });
  });

  it("fails a 401 at once, without retrying", async () => {
    const { post, seen } = scripted([{ status: 401, body: {} }, ok]);
    const ask = httpJevClient({
      questions: pairQuestions,
      model: "jev-1",
      post,
      sleep: noWait,
    });
    await expect(ask({})).rejects.toBeInstanceOf(JevAskError);
    expect(seen).toHaveLength(1);
  });

  it("gives up on a transient failure once the retry budget is spent", async () => {
    const { post, seen } = scripted(
      Array.from({ length: 9 }, () => ({ status: 529, body: {} })),
    );
    const ask = httpJevClient({
      questions: pairQuestions,
      model: "jev-1",
      post,
      sleep: noWait,
      retry: { baseMs: 1, factor: 2, capMs: 1, maxAttempts: 3, jitter: "none" },
    });
    await expect(ask({})).rejects.toThrow(/http_retry/);
    expect(seen).toHaveLength(3);
  });
});
