import { z } from "zod";
import {
  evaluateScopeRatchet,
  hasDirection,
  ratchetTableLines,
  readScopeCeilings,
  recordScopeCeilings,
  type ScopeCountCeilings,
  ScopeCountCeilingsSchema,
  type ScopeCountVerdict,
  scopeOf,
  scopesUnder,
} from "../../packages/code-graph/src/ratchet/scope-count.js";

const scalarSchema = z.union([
  z.number(),
  z.enum(["NaN", "Infinity", "-Infinity", "-0"]),
]);
export type Scalar = z.infer<typeof scalarSchema>;
export function scalar(value: Scalar): number {
  if (typeof value === "number") return value;
  switch (value) {
    case "NaN":
      return NaN;
    case "Infinity":
      return Infinity;
    case "-Infinity":
      return -Infinity;
    case "-0":
      return -0;
  }
}
const strings = z.array(z.string());
const ceilingsSchema = z
  .object({
    default: scalarSchema,
    scopes: z.array(z.tuple([z.string(), scalarSchema])),
  })
  .strict();
const measurementSchema = z
  .object({ scope: z.string(), count: scalarSchema })
  .strict();
const ceilingSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("number"), value: scalarSchema }).strict(),
  z
    .object({
      kind: z.literal("inherited"),
      scope: z.string().refine((key) => Object.hasOwn(Object.prototype, key)),
    })
    .strict(),
]);
const violationSchema = z
  .object({
    scope: z.string(),
    measured: scalarSchema,
    ceiling: ceilingSchema,
    direction: z.enum(["EXCEEDED", "SLACK"]),
    delta: scalarSchema,
  })
  .strict();
export const scopeCountSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("parse"), value: z.unknown() }).strict(),
  z
    .object({ action: z.literal("parse-numbers"), ceilings: ceilingsSchema })
    .strict(),
  z
    .object({
      action: z.literal("evaluate"),
      measurements: z.array(measurementSchema),
      ceilings: ceilingsSchema,
      title: z.string(),
    })
    .strict(),
  z
    .object({
      action: z.literal("table"),
      verdict: z
        .object({
          passed: z.boolean(),
          scopesChecked: scalarSchema,
          violations: z.array(violationSchema),
        })
        .strict(),
      title: z.string(),
    })
    .strict(),
  z
    .object({
      action: z.literal("paths"),
      repoRoot: z.string(),
      absolute: z.string(),
      scopes: strings,
      under: z.string(),
    })
    .strict(),
  z.object({ action: z.literal("read"), file: z.string() }).strict(),
]);
export type ScopeCountInput = z.infer<typeof scopeCountSchema>;
function ceilings(input: z.infer<typeof ceilingsSchema>): ScopeCountCeilings {
  return {
    default: scalar(input.default),
    scopes: Object.fromEntries(
      input.scopes.map(([name, value]) => [name, scalar(value)]),
    ),
  };
}
function numberFacts(number: number) {
  return {
    negativeZero: Object.is(number, -0),
    nonfinite: Number.isNaN(number)
      ? "NaN"
      : number === Infinity
        ? "Infinity"
        : number === -Infinity
          ? "-Infinity"
          : null,
  };
}
function ceilingFacts(ceilings: ScopeCountCeilings) {
  return {
    default: numberFacts(ceilings.default),
    scopes: Object.keys(ceilings.scopes).map((name) => [
      name,
      numberFacts(ceilings.scopes[name]),
    ]),
  };
}
function thrown(error: unknown) {
  if (!(error instanceof TypeError)) throw error;
  return { name: error.name, message: error.message };
}
function schema(value: unknown) {
  try {
    const result = ScopeCountCeilingsSchema.safeParse(value);
    return result.success
      ? { success: true, data: result.data, facts: ceilingFacts(result.data) }
      : { success: false, issues: result.error.issues };
  } catch (error) {
    return { thrown: thrown(error) };
  }
}
function table(verdict: ScopeCountVerdict, title: string) {
  return {
    verdict,
    lines: ratchetTableLines(verdict, title),
    hasExceeded: hasDirection(verdict, "EXCEEDED"),
    hasSlack: hasDirection(verdict, "SLACK"),
  };
}
export function scopeCountReference(input: ScopeCountInput): unknown {
  switch (input.action) {
    case "parse":
      return schema(input.value);
    case "parse-numbers":
      return schema(ceilings(input.ceilings));
    case "evaluate": {
      const measurements = input.measurements.map((row) => ({
        scope: row.scope,
        count: scalar(row.count),
      }));
      const limits = ceilings(input.ceilings);
      Object.freeze(measurements);
      Object.freeze(limits.scopes);
      Object.freeze(limits);
      const verdict = evaluateScopeRatchet(measurements, limits);
      const recorded = recordScopeCeilings(measurements, limits);
      return {
        table: table(verdict, input.title),
        recorded,
        recordedFacts: ceilingFacts(recorded),
        measurementsAfter: measurements,
        ceilingsAfter: limits,
      };
    }
    case "table": {
      // The source's exported number field can carry its actual inherited value at runtime.
      const verdict: ScopeCountVerdict = {
        ...input.verdict,
        scopesChecked: scalar(input.verdict.scopesChecked),
        violations: input.verdict.violations.map((row) => ({
          ...row,
          measured: scalar(row.measured),
          delta: scalar(row.delta),
          ceiling:
            row.ceiling.kind === "number"
              ? scalar(row.ceiling.value)
              : Reflect.get({}, row.ceiling.scope),
        })),
      };
      return table(verdict, input.title);
    }
    case "paths": {
      const scopes = Object.freeze([...input.scopes]);
      const selected = scopesUnder(scopes, input.under);
      const result = [...selected];
      const freshResult = selected !== scopes;
      selected.length = 0;
      return {
        scope: scopeOf(input.repoRoot, input.absolute),
        selected: result,
        inputAfter: scopes,
        freshResult,
      };
    }
    case "read": {
      const messages: string[] = [];
      try {
        return {
          ceilings: readScopeCeilings(input.file, (message) =>
            messages.push(message),
          ),
          messages,
        };
      } catch (error) {
        return { thrown: thrown(error), messages };
      }
    }
  }
}

export function scopeOrderingCases(): { id: string; input: ScopeCountInput }[] {
  const cases: { id: string; input: ScopeCountInput }[] = [];
  const base = { default: 0, scopes: [] };
  function add(id: string, input: unknown) {
    cases.push({ id, input: scopeCountSchema.parse(input) });
  }
  for (const length of [3, 8, 16, 24, 32, 64, 65, 128])
    for (let seed = 0; seed < 3; seed++) {
      let state = seed + 1;
      const measurements = Array.from({ length }, (_, i) => {
        state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
        return {
          scope: `scope-${String.fromCharCode(97 + (state % 26))}-${i % 7}`,
          count: i % 7 === 0 ? "NaN" : (state % 13) - 6,
        };
      });
      add(`mixed-nan-order-${length}-${seed}`, {
        action: "evaluate",
        measurements,
        ceilings: base,
        title: "COUNT",
      });
      add(`ordinary-order-${length}-${seed}`, {
        action: "evaluate",
        measurements: measurements.map((row) => ({
          ...row,
          count: row.count === "NaN" ? 1 : row.count,
        })),
        ceilings: base,
        title: "COUNT",
      });
    }
  for (const length of [63, 64, 65, 127, 128, 129, 256, 257, 1024]) {
    for (const profile of [
      "ascending",
      "descending",
      "left-short",
      "right-short",
      "alternating",
    ]) {
      const split = Math.floor(length / (profile === "right-short" ? 1.25 : 4));
      const measurements = Array.from({ length }, (_, i) => {
        let count =
          profile === "ascending"
            ? length - i
            : profile === "descending"
              ? i + 1
              : i < split
                ? split - i
                : length + split - i;
        if (profile === "alternating")
          count =
            (Math.floor(i / 16) % 2 === 0 ? length : 2 * length) - (i % 16);
        const special =
          i === Math.floor(length / 3) || i === split || i === length - 8;
        return {
          scope: special ? `alpha-${i}` : `scope-${i}`,
          count: special ? "NaN" : count,
        };
      });
      add(`runs-${profile}-${length}`, {
        action: "evaluate",
        measurements,
        ceilings: base,
        title: "COUNT",
      });
      add(`runs-interleaved-${profile}-${length}`, {
        action: "evaluate",
        measurements: measurements.map((row, i) => ({
          ...row,
          scope: `scope-${i}`,
        })),
        ceilings: base,
        title: "COUNT",
      });
    }
  }

  add("ties-descending-start", {
    action: "evaluate",
    measurements: [1, -1, 2, -2].map((count) => ({ scope: "same", count })),
    ceilings: base,
    title: "COUNT",
  });
  add("ties-inside-descending", {
    action: "evaluate",
    measurements: [1, 2, -2, 3].map((count) => ({ scope: "same", count })),
    ceilings: base,
    title: "COUNT",
  });
  add("ties-across-long-runs", {
    action: "evaluate",
    measurements: Array.from({ length: 192 }, (_, i) => ({
      scope: "same",
      count:
        (i < 96 ? 96 - i : 192 - i) *
        ((i + (i < 96 ? 0 : 1)) % 2 === 0 ? 1 : -1),
    })),
    ceilings: base,
    title: "COUNT",
  });
  add("ties-high-merge-unequal-runs", {
    action: "evaluate",
    measurements: [
      ...Array.from({ length: 128 }, (_, i) => ({
        scope: "same",
        count: (128 - i) * (i % 2 === 0 ? 1 : -1),
      })),
      ...Array.from({ length: 64 }, (_, i) => ({
        scope: "same",
        count: (96 - i) * (i % 2 === 0 ? -1 : 1),
      })),
    ],
    ceilings: base,
    title: "COUNT",
  });
  return cases;
}
