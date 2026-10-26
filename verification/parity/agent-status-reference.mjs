import assert from "node:assert/strict";
import readline from "node:readline";
import { z } from "zod";
import { NO_USAGE } from "../../packages/tea/src/agent/internal.ts";
import { status } from "../../packages/tea/src/agent/types.ts";

const frame = z
  .object({
    id: z.string(),
    input: z
      .object({
        state: z.record(z.string(), z.unknown()),
        undefined: z.array(z.enum(["failure", "output", "usage"])).optional(),
        at: z
          .enum(["nan", "infinity", "negativeInfinity", "negativeZero"])
          .optional(),
        cold: z.boolean().optional(),
      })
      .strict(),
  })
  .strict();
const describe = (v) =>
  v === undefined
    ? "undefined"
    : v === null
      ? "null"
      : typeof v === "number"
        ? Object.is(v, -0)
          ? "-0"
          : Number.isNaN(v)
            ? "NaN"
            : v === Infinity
              ? "+Infinity"
              : v === -Infinity
                ? "-Infinity"
                : "number"
        : typeof v;
function execute(input) {
  let s = input.state;
  for (const name of input.undefined ?? []) s[name] = undefined;
  if (input.at) {
    assert.equal(s.run.phase, "cancelled");
    s.run.at = {
      nan: NaN,
      infinity: Infinity,
      negativeInfinity: -Infinity,
      negativeZero: -0,
    }[input.at];
  }
  if (input.cold) s = JSON.parse(JSON.stringify(s));
  const out = status(s),
    again = status(s);
  return {
    wire: JSON.stringify(out),
    kind: out.kind,
    failureOwn: Object.hasOwn(out, "failure"),
    failurePresence: describe(out.failure),
    failureIsAgent: out.kind === "failed" && out.failure === s.failure,
    failureIsRun:
      out.kind === "failed" &&
      Object.hasOwn(s.run, "failure") &&
      out.failure === s.run.failure,
    outputOwn: Object.hasOwn(out, "output"),
    outputPresence: describe(out.output),
    outputSame: out.kind === "done" && out.output === s.output,
    usageSame: out.kind === "done" && out.usage === s.usage,
    sharedNoUsage: out.kind === "done" && out.usage === NO_USAGE,
    pendingSame: out.kind === "suspended" && out.pending === s.tools.running,
    pendingRepeatSame:
      out.kind === "suspended" && out.pending === again.pending,
    atPresence: describe(out.at),
    runPhase: s.run.phase,
  };
}
for await (const line of readline.createInterface({
  input: process.stdin,
  crlfDelay: Infinity,
})) {
  let id;
  try {
    const raw = JSON.parse(line);
    id = raw.id;
    const row = frame.parse(raw);
    console.log(
      JSON.stringify({ id: row.id, ok: true, output: execute(row.input) }),
    );
  } catch (e) {
    console.log(
      JSON.stringify({
        id,
        ok: false,
        error: { name: e.name, message: e.message },
      }),
    );
  }
}
