import { z } from "zod";
import { pbtPropertyCases, pbtPropertyScript } from "./pbt-property-cases.mts";

const check = z.enum(["terminates", "trace"]);
export const pbtInvoiceScript = z
  .object({
    kind: z.literal("invoice"),
    check,
    loaded: z.enum(["fresh", "done", "gaveUp"]),
    rule: z.enum(["done", "gaveUp", "provenance", "false", "error"]),
    runs: z.number().int().min(0).max(3),
    events: z.array(
      z.enum(["start", "tick", "unpaid", "paid", "error", "noop", "unknown"]),
    ),
  })
  .strict();
export type PbtInvoiceScript = z.infer<typeof pbtInvoiceScript>;
export function pbtFinalCases() {
  const counter = ["terminates", "trace"].flatMap((operation) => {
    const mode = check.parse(operation);
    return [
      ...pbtPropertyCases()
        .filter((c) => c.input.kind === "property")
        .map((c) => ({
          id: c.id.replace("pbt-property", `pbt-${mode}`),
          input: { ...c.input, check: mode },
        })),
      ...["true", "false"].map((kind) => ({
        id: `pbt-${mode}.loaded-empty-${kind}`,
        input: {
          ...pbtPropertyScript.parse({
            kind: "property",
            form: "transitions",
            loaded: { n: 5, done: true },
            initDelta: 10,
            bootCommand: true,
            terminalRefuses: true,
            predicate: { kind, at: 0 },
            runs: 1,
            messages: [],
          }),
          check: mode,
        },
      })),
    ];
  });
  const invoice: { id: string; input: PbtInvoiceScript }[] = [];
  const histories = [
    [
      "complete",
      "fresh",
      ["start", "tick", "unpaid", "tick", "paid", "tick", "noop"],
      "done",
    ],
    ["empty-fresh", "fresh", [], "done"],
    ["empty-restored-done", "done", [], "done"],
    ["empty-restored-gave-up", "gaveUp", [], "gaveUp"],
    [
      "restart-after-done",
      "done",
      ["start", "tick", "unpaid", "tick", "paid"],
      "done",
    ],
    ["restart-incomplete", "done", ["start", "tick", "unpaid"], "done"],
    ["exhausted", "fresh", ["start", "tick", "error", "tick"], "gaveUp"],
    ["late-unpaid", "done", ["tick", "unpaid", "noop"], "done"],
    [
      "repeated-paid",
      "fresh",
      ["start", "paid", "paid", "noop", "tick"],
      "done",
    ],
    ["original-error", "fresh", ["start", "tick", "paid"], "error"],
    ["refusal-skips-check", "fresh", ["start", "tick", "unknown"], "false"],
    [
      "false-with-whole-history",
      "fresh",
      ["start", "tick", "unpaid", "paid", "noop"],
      "false",
    ],
  ] as const;
  for (const mode of ["terminates", "trace"] as const)
    for (const [name, loaded, events, rule] of histories)
      invoice.push({
        id: `pbt-${mode}.invoice.${name}`,
        input: pbtInvoiceScript.parse({
          kind: "invoice",
          check: mode,
          loaded,
          events,
          runs: 1,
          rule:
            mode === "trace" && rule !== "error" && rule !== "false"
              ? "provenance"
              : rule,
        }),
      });
  return { counter, invoice };
}
