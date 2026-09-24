// Preload (`node --import`) for the tutorial's CI run: stands in for the
// Anthropic Messages API with the recorded turns in `TEA_TUTORIAL_FIXTURE`.
// The reply is chosen by how many assistant turns the request already carries,
// not by a call counter — so a process that resumes mid-run re-asks for the
// same turn and gets the same answer, exactly as the real API would.
//
// `TEA_TUTORIAL_HOLD_TURN=<n>` makes the request for turn n hang forever after
// printing a marker: the point at which the test kills the process, with the
// Model for every earlier turn already saved by the substrate.
//
// `TEA_TUTORIAL_REQUEST_LOG=<file>` appends every request body as one JSON
// line, held ones included, so the test can read what the adapter actually
// sent back — the replayed thinking blocks above all.
import { appendFileSync, readFileSync } from "node:fs";

const fixture = JSON.parse(
  readFileSync(process.env.TEA_TUTORIAL_FIXTURE, "utf8"),
);
const holdTurn =
  process.env.TEA_TUTORIAL_HOLD_TURN === undefined
    ? null
    : Number(process.env.TEA_TUTORIAL_HOLD_TURN);
const requestLog = process.env.TEA_TUTORIAL_REQUEST_LOG;
const realFetch = globalThis.fetch;

globalThis.fetch = async (input, init) => {
  const url = typeof input === "string" ? input : input.url;
  if (!url.startsWith("https://api.anthropic.com/"))
    return realFetch(input, init);
  const body = JSON.parse(init.body);
  const turn = body.messages.filter((m) => m.role === "assistant").length;
  if (requestLog !== undefined)
    appendFileSync(requestLog, `${JSON.stringify({ turn, body })}\n`);
  if (turn === holdTurn) {
    process.stdout.write(`fixture: holding turn ${turn}\n`);
    return new Promise(() => {});
  }
  const reply = fixture.turns[turn];
  if (reply === undefined) {
    throw new Error(`fixture: no recorded reply for turn ${turn}`);
  }
  return new Response(JSON.stringify(reply), {
    status: 200,
    headers: {
      "content-type": "application/json",
      "request-id": `fixture-${turn}`,
    },
  });
};
