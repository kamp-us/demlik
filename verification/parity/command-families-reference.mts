import { createInterface } from "node:readline";
import { z } from "zod";
import {
  Cmd,
  cmdContractOver,
  Outcome,
  type validateSync,
} from "../../packages/tea/src/pure/core.ts";

type Schema<T> = Parameters<typeof validateSync<T>>[0];
const input = z.object({ key: z.string() });
const output: Schema<string> = {
  "~standard": {
    version: 1,
    vendor: "parity",
    validate(value) {
      return typeof value === "string" && value !== "bad"
        ? { value: value.trim().toUpperCase() }
        : { issues: [{ message: "expected a useful result" }] };
    },
  },
};
const definition = (name: string, schema = output) =>
  Cmd.define(name, { input, ok: schema, err: ["declared"] });
const prefix = (text: string): Schema<string> => ({
  "~standard": {
    version: 1,
    vendor: "parity",
    validate(value) {
      return { value: `${text}:${value}` };
    },
  },
});
const caseSchema = z.object({
  id: z.string(),
  input: z.object({
    left: z.string(),
    right: z.string(),
    at: z.number(),
    mode: z.enum(["ok", "malformed", "declared", "undeclared", "none"]),
  }),
});
function errorData(error: unknown) {
  if (!(error instanceof Error)) throw error;
  return {
    name: error.name,
    message: error.message,
    ...Object.fromEntries(Object.entries(error)),
  };
}
function result<T>(action: () => T) {
  try {
    return action() ?? null;
  } catch (error) {
    return { error: errorData(error) };
  }
}
function check(action: () => void) {
  try {
    action();
    return { accepted: true };
  } catch (error) {
    return { accepted: false, error: errorData(error) };
  }
}
function terminal(value: unknown): asserts value is { readonly type: string } {
  z.object({ type: z.string() }).parse(value);
}
function execute(trace: z.infer<typeof caseSchema>["input"]) {
  const left = definition(trace.left);
  const right = definition(trace.right);
  const a = left({ key: "a" });
  const b = right({ key: "b" });
  const contract = cmdContractOver([left, right], () => trace.at);
  const completion =
    trace.mode === "none"
      ? undefined
      : trace.mode === "ok" || trace.mode === "malformed"
        ? Outcome.ok(trace.mode === "ok" ? " value " : "bad")
        : Outcome.err({
            _tag: trace.mode === "declared" ? "declared" : "other",
            detail: [0, 255],
          });
  const typed = [a, b].map((command) =>
    result(() => contract.settle(command, completion)),
  );
  const cross = left.ok(b, "replay", 0);
  const crossChecks = [a, b].map((command) =>
    check(() => contract.checkDispatch(command, cross)),
  );
  const minted = contract.settle(a, Outcome.ok(" value "));
  const restored = JSON.parse(JSON.stringify(minted));
  const foreign = cmdContractOver([left, right], () => trace.at).settle(
    a,
    Outcome.ok(" value "),
  );
  const alias = definition(trace.left);
  const sameNameMint = contract.settle(a, Outcome.ok(" value "));
  terminal(minted);
  terminal(foreign);
  terminal(sameNameMint);
  const guards = {
    minted: check(() => contract.checkDispatch(a, minted)),
    restored: check(() => contract.checkDispatch(a, restored)),
    foreign: check(() => contract.checkDispatch(a, foreign)),
    sameName: check(() =>
      contract.checkDispatch(alias({ key: "a" }), sameNameMint),
    ),
  };
  const first = definition(trace.left, prefix("first"));
  const second = definition(trace.left, prefix("second"));
  const duplicate = [
    [first, second],
    [second, first],
  ].map((definitions) =>
    cmdContractOver(definitions, () => trace.at).settle(a, Outcome.ok("value")),
  );
  return {
    declarations: [left, right].map((def) => ({
      cmdType: def.cmdType,
      okType: def.okType,
      errType: def.errType,
      errorTags: def.errTags,
    })),
    commands: [a, b],
    ownedName: a.type,
    typed,
    wire: typed,
    cross,
    restoredCross: JSON.parse(JSON.stringify(cross)),
    crossChecks,
    guards,
    selectedByCommand: contract.settle(a, Outcome.ok(" value ")),
    duplicate,
  };
}
for await (const line of createInterface({ input: process.stdin })) {
  try {
    const test = caseSchema.parse(JSON.parse(line));
    process.stdout.write(
      `${JSON.stringify({ id: test.id, ok: true, output: execute(test.input) })}\n`,
    );
  } catch (error) {
    process.stdout.write(
      `${JSON.stringify({ ok: false, error: errorData(error) })}\n`,
    );
  }
}
