import assert from "node:assert/strict";
import { createInterface } from "node:readline";
import { z } from "zod";
import { tool, toolRouter } from "../../packages/tea/src/agent/index.ts";
import {
  cmdEdgeOver,
  type validateSync,
} from "../../packages/tea/src/pure/core.ts";

type Args = { invoice: string };
type Result = { total: number; parser: string };
type Schema<T> = Parameters<typeof validateSync<T>>[0];
type Host = { mode: "ok" | "error" };
const frameSchema = z.object({
  id: z.string(),
  input: z.object({
    mode: z.literal("same-name"),
    scenario: z.enum(["ok", "error"]),
  }),
});
const wire = (value: unknown): unknown => JSON.parse(JSON.stringify(value));
function tagged(value: unknown): value is { type: string } {
  return (
    typeof value === "object" &&
    value !== null &&
    "type" in value &&
    typeof value.type === "string"
  );
}
async function execute(mode: Host["mode"]) {
  const trace: string[] = [];
  const input = (owner: string): Schema<Args> => ({
    "~standard": {
      version: 1,
      vendor: "same-name-fixture",
      validate(raw) {
        trace.push(`input:${owner}`);
        if (
          typeof raw !== "object" ||
          raw === null ||
          !("invoice" in raw) ||
          typeof raw.invoice !== "string"
        )
          return { issues: [{ message: "invoice required" }] };
        return { value: { invoice: `${owner}:${raw.invoice}` } };
      },
    },
  });
  const output = (owner: string): Schema<Result> => ({
    "~standard": {
      version: 1,
      vendor: "same-name-fixture",
      validate(raw) {
        trace.push(`output:${owner}`);
        if (
          typeof raw !== "object" ||
          raw === null ||
          !("total" in raw) ||
          typeof raw.total !== "number"
        )
          return { issues: [{ message: "total required" }] };
        return {
          value: {
            total: raw.total + (owner === "B" ? 100 : 1),
            parser: owner,
          },
        };
      },
    },
  });
  const tagsA: string[] = ["a_only"],
    tagsB: string[] = ["b_only"],
    originalError = { _tag: "b_only", from: "B" };
  const a = tool(
    "same_invoice",
    { description: "A", input: input("A"), ok: output("A"), err: tagsA },
    async (args, _ctx: Host, { ok }) => {
      trace.push(`handler:A:${args.invoice}`);
      return ok({ total: 1, parser: "raw-A" });
    },
  );
  const b = tool(
    "same_invoice",
    { description: "B", input: input("B"), ok: output("B"), err: tagsB },
    async (args, ctx: Host, { ok, fail }) => {
      trace.push(`handler:B:${args.invoice}`);
      return ctx.mode === "error"
        ? fail(originalError)
        : ok({ total: 20, parser: "raw-B" });
    },
  );
  const routerA = toolRouter([a]),
    routerB = toolRouter([b]);
  const command = routerA.toolOf({
    callId: "from-A",
    name: "same_invoice",
    args: { invoice: "inv-17" },
  });
  assert.equal(command.type, "same_invoice");
  if (command.type !== "same_invoice") throw new Error("unexpected rejection");
  const typedForB: Parameters<typeof b.interpret>[0] = command;
  const returned = await b.interpret(typedForB, {
    mode,
    emit() {
      throw new Error("unexpected emission");
    },
  });
  const settled = cmdEdgeOver(routerB.defs, () => 17.25)(command, returned);
  assert.ok(tagged(settled));
  const own =
    typeof settled === "object" &&
    settled !== null &&
    "cmd" in settled &&
    typeof settled.cmd === "object" &&
    settled.cmd !== null &&
    "args" in settled.cmd
      ? settled.cmd.args === command.args
      : false;
  const errorSame =
    mode === "error" && "error" in settled
      ? settled.error === originalError
      : null;
  return {
    view: {
      command: wire(command),
      returned: wire(returned),
      settled: wire(settled),
      outcome: wire(routerB.outcomeOf(settled)),
      argsSame: own,
      errorSame,
      tagsA: a.errTags,
      tagsB: b.errTags,
      trace,
    },
    sourceOnly: {
      commandObjectSame: "cmd" in settled && settled.cmd === command,
    },
  };
}
for await (const line of createInterface({
  input: process.stdin,
  crlfDelay: Infinity,
})) {
  const frame = frameSchema.parse(JSON.parse(line));
  process.stdout.write(
    `${JSON.stringify({ id: frame.id, ...(await execute(frame.input.scenario)) })}\n`,
  );
}
