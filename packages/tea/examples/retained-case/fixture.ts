import assert from "node:assert/strict";
import { fileJournal } from "@demlik/tea/node";
import { MAX_MODEL_TURNS, type Ports } from "./agent";
import { type CaseHost, type CaseView, openCase } from "./host";
import { parseRecord } from "./source";

export function fixturePorts(): Ports {
  let clock = 1_000;
  return {
    now: () => ++clock,
    model: async (previousTurns) => {
      const turn = previousTurns + 1;
      return turn === 14
        ? {
            content:
              "Investigation complete: ten sources and three lookup failures reviewed.",
            toolCalls: [],
          }
        : {
            content: `Settled reasoning ${turn}`,
            toolCalls: [
              { callId: `search-${turn}`, name: "search", args: { turn } },
            ],
          };
    },
    search: async (turn) => {
      if ([3, 7, 11].includes(turn)) throw new Error(`Lookup ${turn} failed`);
      return {
        snippet: `Evidence ${turn}, retained independently of active context`,
      };
    },
    summarize: async () => ({
      summary:
        "Earlier evidence summarized for active reasoning; the case archive retains the originals.",
    }),
  };
}

export function committedView(host: CaseHost): CaseView {
  const state = host.read();
  assert.equal(state.kind, "ready");
  return state.committed.view;
}

export function verifyCase(host: CaseHost): CaseView {
  const view = committedView(host);
  const events = view.history.map((entry) => entry.event);
  assert.equal(
    events.filter((event) => event.type === "TurnSettled").length,
    14,
  );
  assert.equal(events.filter((event) => event.type === "ToolFailed").length, 3);
  assert.equal(
    events.filter((event) => event.type === "ToolSettled").length,
    10,
  );
  assert.equal(view.compactions, 2);
  assert.equal(view.outcome.kind, "done");
  assert.equal(view.maxActiveTurns, 6);
  assert.equal(view.maxActiveTools, 7);
  assert.ok(view.maxActiveTools <= MAX_MODEL_TURNS);
  assert.equal(
    new Set(view.history.map((entry) => entry.id)).size,
    view.history.length,
  );
  assert.ok(
    view.history.every(
      (entry, index) =>
        index === 0 || entry.seq >= (view.history[index - 1]?.seq ?? 0),
    ),
  );
  assert.ok(
    events.some(
      (event) =>
        event.type === "ToolSettled" &&
        event.result.snippet.startsWith("Evidence 1,"),
    ),
  );
  const state = host.read();
  assert.ok(
    state.kind === "ready" && state.committed.model.conversation === null,
  );
  return view;
}

export async function runFixture(directory: string) {
  const runId = "investigation-593";
  const first = await openCase(
    fileJournal(directory, parseRecord),
    runId,
    fixturePorts(),
  );
  if (committedView(first).revision === 0) await first.start();
  else await first.resume();
  const expected = verifyCase(first);
  await first.stop();
  const reopened = await openCase(
    fileJournal(directory, parseRecord),
    runId,
    fixturePorts(),
  );
  assert.deepEqual(verifyCase(reopened), expected);
  for (let cycle = 0; cycle < 3; cycle++) {
    const client = await reopened.connect();
    const frame = await client.next();
    assert.ok(!frame.done);
    assert.deepEqual(frame.value.view, expected);
    client.close();
  }
  await reopened.stop();
  return expected;
}
