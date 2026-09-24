/**
 * The skip-saving-transient-states how-to's compile-and-run gate (#317).
 *
 * `docs/how-to/skip-saving-transient-states.md` claims one plain `Store`
 * wrapper keeps a streaming reply off disk on both engines, with no tea API
 * behind it. The wrapper and machine are `examples/streaming-reply.ts`; each
 * engine's run code is its own example beside it. This file drives both
 * through a store that records every save, and asserts the page shows the
 * three files verbatim, so the page cannot drift from what runs.
 *
 * It lives under `src/effect/` because it imports `effect`, which only this
 * entry may do.
 */

import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import {
  isStreaming,
  type ReplyState,
  reply,
  skipSaving,
} from "../../examples/streaming-reply";
import { streamReply as onEffect } from "../../examples/streaming-reply-effect";
import { streamReply as onPromise } from "../../examples/streaming-reply-promise";
import type { Store } from "../index";
import { memoryStore } from "../mem/index";
import { run } from "../promise";

/** A memory store that also records every state it was asked to save. */
function recordingStore() {
  const inner = memoryStore<ReplyState>();
  const saved: ReplyState[] = [];
  const store: Store<ReplyState> = {
    load: () => inner.load(),
    save: (state) => {
      saved.push(state);
      return inner.save(state);
    },
    migrate: (raw) => inner.migrate(raw),
  };
  const loaded = async () => store.migrate(await store.load());
  return { store, saved, loaded };
}

const tokens = ["Hel", "lo", "!"];
const finished: ReplyState = { phase: "done", text: "Hello!" };

describe("skipSaving — the page's wrapper, on both engines", () => {
  it.each([
    ["Promise", (store: Store<ReplyState>) => onPromise(store, tokens)],
    [
      "Effect",
      (store: Store<ReplyState>) => Effect.runPromise(onEffect(store, tokens)),
    ],
  ])("on the %s engine, no streaming state is saved and load returns the final state", async (_engine, stream) => {
    const { store, saved, loaded } = recordingStore();

    const final = await stream(store);

    expect(final).toEqual(finished);
    expect(saved.filter(isStreaming)).toEqual([]);
    // The page's claim: boot, `finish`, and the flush at stop.
    expect(saved.map((s) => s.phase)).toEqual(["idle", "done", "done"]);
    expect(await loaded()).toEqual(final);
  });

  it("without the wrapper every streaming state is saved — the test is not vacuous", async () => {
    const { store, saved } = recordingStore();
    const runtime = await run(reply, { store }).ready;
    await runtime.dispatch({ type: "start" });
    for (const text of tokens) await runtime.dispatch({ type: "token", text });
    await runtime.stop();

    // `start`, one per token, and the flush at `stop()`.
    expect(saved.filter(isStreaming)).toHaveLength(1 + tokens.length + 1);
  });

  it("a stop mid-stream keeps the last lasting state on disk", async () => {
    const { store, saved, loaded } = recordingStore();
    const runtime = await run(reply, {
      store: skipSaving(store, isStreaming),
    }).ready;
    await runtime.dispatch({ type: "start" });
    await runtime.dispatch({ type: "token", text: "Hel" });
    await runtime.stop();

    expect(saved.filter(isStreaming)).toEqual([]);
    expect(await loaded()).toEqual({ phase: "idle", text: "" });
  });
});

const read = (path: string) =>
  readFile(fileURLToPath(new URL(path, import.meta.url)), "utf8");

/** Every fenced ```ts block on the page, in page order. */
async function tsBlocks(): Promise<string[]> {
  const markdown = await read(
    "../../docs/how-to/skip-saving-transient-states.md",
  );
  return [...markdown.matchAll(/```ts\n([\s\S]*?)```/g)].map((m) =>
    (m[1] ?? "").trimEnd(),
  );
}

describe("the skip-saving how-to — it cannot rot", () => {
  it.each([
    "streaming-reply.ts",
    "streaming-reply-promise.ts",
    "streaming-reply-effect.ts",
  ])("the page shows %s verbatim", async (file) => {
    const example = (await read(`../../examples/${file}`)).trimEnd();
    expect(await tsBlocks()).toContain(example);
  });
});
