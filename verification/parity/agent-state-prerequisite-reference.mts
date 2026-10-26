import readline from "node:readline";
import { z } from "zod";
import {
  addUsage,
  foldSummary,
  NO_USAGE,
} from "../../packages/tea/src/agent/internal.ts";
import {
  type AgentTurn,
  isAgentTurn,
  isTurnUsage,
} from "../../packages/tea/src/agent/types.ts";

const normalize = (v: unknown): unknown => {
  if (v === undefined) return { $undefined: true };
  if (typeof v === "number" && (!Number.isFinite(v) || Object.is(v, -0)))
    return { $number: Object.is(v, -0) ? "-0" : String(v) };
  if (Array.isArray(v)) return v.map(normalize);
  if (v !== null && typeof v === "object")
    return Object.fromEntries(
      Object.entries(v).map(([k, x]) => [k, normalize(x)]),
    );
  return v;
};
const snapshot = (v: unknown) => ({
  json: JSON.stringify(v),
  value: normalize(v),
});
const request = z
  .object({
    id: z.string(),
    operation: z.enum(["defaults", "copy", "sum", "fold"]),
    input: z.unknown(),
  })
  .strict();
const legacy = z.enum(["absent", "undefined", "null"]).optional();
const folding = z.enum([
  "NaN",
  "Infinity",
  "-Infinity",
  "-0",
  "-0.5",
  "0",
  "1",
  "2",
  "50",
]);
function override(v: Record<string, unknown>, form: z.infer<typeof legacy>) {
  if (form === "absent") delete v.usage;
  else if (form === "undefined") v.usage = undefined;
  else if (form === "null") v.usage = null;
}
function parse(encoded: string) {
  return JSON.parse(encoded);
}
async function execute(operation: string, input: unknown) {
  switch (operation) {
    case "defaults": {
      z.object({}).strict().parse(input);
      const a = NO_USAGE,
        b = NO_USAGE;
      return { same: a === b, usage: snapshot(a) };
    }
    case "copy": {
      const x = z.object({ encoded: z.string(), legacy }).strict().parse(input),
        before = parse(x.encoded);
      override(before, x.legacy);
      const after = { ...before };
      const kind = (v: typeof before) =>
        !Object.hasOwn(v, "usage")
          ? "absent"
          : v.usage === undefined
            ? "undefined"
            : v.usage === null
              ? "null"
              : "value";
      return {
        before: snapshot(before),
        after: snapshot(after),
        turnArraySame: before.turns === after.turns,
        recordArraySame: before.toolRecords === after.toolRecords,
        elementsSame: before.turns.every(
          (v: unknown, i: number) => v === after.turns[i],
        ),
        outcomesSame: before.toolRecords.every(
          (v: { outcome: unknown }, i: number) =>
            v.outcome === after.toolRecords[i].outcome,
        ),
        legacyBefore: kind(before),
        legacyAfter: kind(after),
        usageSame: before.usage === after.usage,
      };
    }
    case "sum": {
      const x = z
          .object({ left: z.string(), right: z.string() })
          .strict()
          .parse(input),
        left = parse(x.left),
        right = parse(x.right);
      return {
        left: snapshot(left),
        right: snapshot(right),
        sum: snapshot(addUsage(left, right)),
        leftGuard: isTurnUsage(left),
      };
    }
    case "fold": {
      const x = z
          .object({
            encoded: z.string(),
            folding,
            summary: z.custom<AgentTurn>(isAgentTurn),
            legacy,
          })
          .strict()
          .parse(input),
        before = parse(x.encoded);
      override(before, x.legacy);
      const out = foldSummary(before, Number(x.folding), x.summary);
      const origins = out.toolRecords.map((item) =>
        before.toolRecords.findIndex(
          (v: typeof item) =>
            v.call === item.call && v.outcome === item.outcome,
        ),
      );
      const kind = (v: typeof before) =>
        !Object.hasOwn(v, "usage")
          ? "absent"
          : v.usage === undefined
            ? "undefined"
            : v.usage === null
              ? "null"
              : "value";
      return {
        before: snapshot(before),
        after: snapshot(out),
        freshTurns: before.turns !== out.turns,
        freshRecords: before.toolRecords !== out.toolRecords,
        summarySame: out.turns[0] === x.summary,
        originalIndices: origins,
        recordCopies: out.toolRecords.every(
          (v, i) => v !== before.toolRecords[origins[i]],
        ),
        legacyBefore: kind(before),
        legacyAfter: kind(out),
      };
    }
    default:
      throw new Error("unknown operation");
  }
}
for await (const line of readline.createInterface({
  input: process.stdin,
  crlfDelay: Infinity,
})) {
  try {
    const r = request.parse(JSON.parse(line));
    console.log(
      JSON.stringify({
        id: r.id,
        ok: true,
        output: await execute(r.operation, r.input),
      }),
    );
  } catch (error) {
    console.log(JSON.stringify({ id: null, ok: false, error: String(error) }));
  }
}
