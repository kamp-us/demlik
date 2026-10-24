import { createInterface } from "node:readline";
import { z } from "zod";
import {
  sccMembers,
  stronglyConnectedComponents,
} from "../../packages/code-graph/src/scc.ts";
import {
  asRng,
  backoffDelay,
} from "../../packages/tea/src/retry-backoff/index.ts";
import { coreInput, executeCore } from "./core.mts";
import {
  executeProbe,
  executeRetryState,
  probeInput,
  retryStateInput,
} from "./retry.mts";

const specialNumbers = {
  NaN: Number.NaN,
  Infinity: Number.POSITIVE_INFINITY,
  "-Infinity": Number.NEGATIVE_INFINITY,
  "-0": -0,
};

const number = z.union([
  z.number(),
  z
    .object({ $number: z.enum(["NaN", "Infinity", "-Infinity", "-0"]) })
    .transform((value) => specialNumbers[value.$number]),
]);

function encodeNumber(value: number) {
  if (Number.isNaN(value)) return { $number: "NaN" };
  if (value === Infinity) return { $number: "Infinity" };
  if (value === -Infinity) return { $number: "-Infinity" };
  if (Object.is(value, -0)) return { $number: "-0" };
  return value;
}

function operation<T>(schema: z.ZodType<T>, execute: (input: T) => unknown) {
  return (input: unknown) => execute(schema.parse(input));
}

const graphInput = z.object({
  nodes: z.array(z.string()),
  adjacency: z.record(z.string(), z.array(z.string())),
});

const operations: Record<string, (input: unknown) => unknown> = {
  "tea.core.machine": operation(coreInput, executeCore),
  "tea.retry.state": operation(retryStateInput, executeRetryState),
  "tea.retry.probe": operation(probeInput, executeProbe),
  "tea.retry.backoff": operation(
    z.object({
      attempt: number,
      curve: z.object({
        baseMs: number,
        factor: number,
        capMs: number,
        jitter: z.enum(["none", "full", "equal"]),
      }),
      random: z.array(number),
    }),
    (input) => {
      let consumed = 0;
      const value = backoffDelay(
        input.attempt,
        input.curve,
        asRng(() => {
          if (consumed >= input.random.length)
            throw new Error("recorded random draws exhausted");
          return input.random[consumed++];
        }),
      );
      return { value: encodeNumber(value), randomDraws: consumed };
    },
  ),
  "code_graph.scc": operation(graphInput, (input) => ({
    components: [
      ...stronglyConnectedComponents(
        input.nodes,
        new Map(Object.entries(input.adjacency)),
      ),
    ],
  })),
  "code_graph.scc_members": operation(graphInput, (input) => {
    const components = stronglyConnectedComponents(
      input.nodes,
      new Map(Object.entries(input.adjacency)),
    );
    return { members: [...sccMembers(input.nodes, components)] };
  }),
};

const envelope = z.object({
  id: z.string(),
  operation: z.string(),
  input: z.unknown(),
});

for await (const line of createInterface({ input: process.stdin })) {
  const test = envelope.parse(JSON.parse(line));
  let response: unknown;
  try {
    const execute = operations[test.operation];
    if (!execute) throw new Error(`unsupported operation: ${test.operation}`);
    response = { id: test.id, ok: true, output: execute(test.input) };
  } catch (error) {
    response = {
      id: test.id,
      ok: false,
      error: { kind: "driver_error", message: String(error) },
    };
  }
  process.stdout.write(`${JSON.stringify(response)}\n`);
}
