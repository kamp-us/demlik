import { z } from "zod";
import {
  type ApiDiff,
  diffSubpathNames,
} from "../../packages/code-graph/src/api/diff.js";
import {
  ApiInputError,
  ApiMapSchema,
  apiSubpaths,
  baseApiSubpaths,
} from "../../packages/code-graph/src/api/map.js";
import {
  BUMPS,
  BumpPolicySchema,
  bumpPolicy,
} from "../../packages/code-graph/src/api/ratchet/policy.js";
import { renderApiRatchet } from "../../packages/code-graph/src/api/ratchet/text.js";
import {
  apiChanges,
  ratchetApiDiff,
} from "../../packages/code-graph/src/api/ratchet/verdict.js";
import type { ApiEntryText } from "../../packages/code-graph/src/api/read.js";
import { stableStringify } from "../../packages/code-graph/src/render/json.js";

const requiredUnknown = z
  .unknown()
  .refine((value) => value !== undefined, "required JSON value");
const index = z.number().int().nonnegative();
const pairs = z.array(z.tuple([z.string(), index]));
export const apiPoolSchema = z.strictObject({
  references: z.array(z.array(z.tuple([z.string(), z.string()]))),
  entries: z.array(z.strictObject({ text: z.string(), references: index })),
});
const subpath = z.strictObject({
  subpath: z.string(),
  tier: z.string().nullable(),
  added: pairs,
  removed: pairs,
  changed: z.array(z.tuple([z.string(), index, index])),
});
export const apiDiffSchema = z.strictObject({
  root: z.string(),
  base: z.string(),
  compiler: z.string(),
  subpaths: z.array(subpath),
});
const changesets = z.strictObject({
  package: z.string(),
  changesets: z.array(
    z.strictObject({
      file: z.string(),
      bump: z.enum(["patch", "minor", "major"]),
      body: z.string(),
    }),
  ),
});
const scalar = z.union([
  z.number(),
  z.enum(["NaN", "Infinity", "-Infinity", "-0"]),
]);
const context = z.strictObject({ changes: scalar, callout: z.string() });
const verdict = z.strictObject({
  passed: z.boolean(),
  base: z.string(),
  package: z.string(),
  changesets: z.array(z.string()),
  highestBump: z.enum(BUMPS),
  calloutFound: z.boolean(),
  misses: z.array(
    z.strictObject({
      subpath: z.string(),
      tier: z.string().nullable(),
      name: z.string(),
      kind: z.enum(["added", "changed", "removed"]),
      before: index.nullable(),
      after: index.nullable(),
      needs: z.strictObject({ bump: z.enum(BUMPS), callout: z.boolean() }),
    }),
  ),
});
export const apiFoundationSchema = z.discriminatedUnion("action", [
  z.strictObject({ action: z.literal("parse-map"), value: requiredUnknown }),
  z.strictObject({ action: z.literal("parse-policy"), value: requiredUnknown }),
  z.strictObject({ action: z.literal("policy"), value: requiredUnknown }),
  z.strictObject({
    action: z.literal("subpaths"),
    root: z.string(),
    map: requiredUnknown,
    base: z.string().nullable(),
  }),
  z.strictObject({
    action: z.literal("diff"),
    pool: apiPoolSchema,
    tier: z.string().nullable(),
    before: pairs,
    after: pairs,
  }),
  z.strictObject({
    action: z.literal("changes"),
    pool: apiPoolSchema,
    diff: apiDiffSchema,
  }),
  z.strictObject({
    action: z.literal("ratchet"),
    pool: apiPoolSchema,
    diff: apiDiffSchema,
    policy: requiredUnknown,
    changesets,
    context,
  }),
  z.strictObject({
    action: z.literal("render"),
    pool: apiPoolSchema,
    verdict,
    context,
  }),
]);
export type ApiFoundationInput = z.infer<typeof apiFoundationSchema>;
export type ApiPoolInput = z.infer<typeof apiPoolSchema>;
export type ApiDiffInput = z.infer<typeof apiDiffSchema>;
function poolOf(input: ApiPoolInput) {
  const references = input.references.map((rows) => Object.fromEntries(rows));
  const entries: ApiEntryText[] = input.entries.map((entry) => {
    const refs = references[entry.references];
    if (refs === undefined) throw new Error("reference index outside pool");
    return { text: entry.text, references: refs };
  });
  function entry(index: number): ApiEntryText {
    const value = entries[index];
    if (value === undefined) throw new Error("entry index outside pool");
    return value;
  }
  const names = (rows: [string, number][]) =>
    Object.fromEntries(rows.map(([name, index]) => [name, entry(index)]));
  function identity(value: ApiEntryText | null | undefined) {
    if (value == null) return null;
    const at = entries.indexOf(value),
      ref = references.indexOf(value.references);
    return { entry: at < 0 ? null : at, references: ref < 0 ? null : ref };
  }
  return { entry, names, identity };
}
function diffOf(input: ApiDiffInput, pool: ReturnType<typeof poolOf>): ApiDiff {
  return {
    root: input.root,
    base: input.base,
    compiler: input.compiler,
    subpaths: Object.fromEntries(
      input.subpaths.map((part) => [
        part.subpath,
        {
          tier: part.tier,
          added: Object.fromEntries(
            part.added.map(([name, index]) => [
              name,
              { after: pool.entry(index) },
            ]),
          ),
          removed: Object.fromEntries(
            part.removed.map(([name, index]) => [
              name,
              { before: pool.entry(index) },
            ]),
          ),
          changed: Object.fromEntries(
            part.changed.map(([name, before, after]) => [
              name,
              { before: pool.entry(before), after: pool.entry(after) },
            ]),
          ),
        },
      ]),
    ),
  };
}
function scalarOf(value: z.infer<typeof scalar>): number {
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
function thrown(error: unknown) {
  if (!(error instanceof TypeError || error instanceof ApiInputError))
    throw error;
  return { thrown: { name: error.name, message: error.message } };
}
const normalize = (value: unknown): unknown =>
  JSON.parse(JSON.stringify(value));
export function apiFoundationReference(input: ApiFoundationInput): unknown {
  switch (input.action) {
    case "parse-map":
    case "parse-policy": {
      try {
        const parsed =
          input.action === "parse-map"
            ? ApiMapSchema.safeParse(input.value)
            : BumpPolicySchema.safeParse(input.value);
        return parsed.success
          ? { success: true, data: parsed.data }
          : { success: false, issues: parsed.error.issues };
      } catch (error) {
        return thrown(error);
      }
    }
    case "policy":
      try {
        return bumpPolicy(input.value);
      } catch (error) {
        return thrown(error);
      }
    case "subpaths":
      try {
        return input.base === null
          ? apiSubpaths(input.root, input.map)
          : baseApiSubpaths(input.root, input.map, input.base);
      } catch (error) {
        return thrown(error);
      }
    case "diff": {
      const pool = poolOf(input.pool),
        before = pool.names(input.before),
        after = pool.names(input.after);
      const diff = diffSubpathNames(input.tier, before, after);
      const prototype = (record: object) => {
        const value = Object.getPrototypeOf(record);
        return value === Object.prototype
          ? null
          : {
              before: pool.identity(value.before),
              after: pool.identity(value.after),
            };
      };
      const changes = apiChanges({
        root: "root",
        base: "base",
        compiler: "compiler",
        subpaths: { ".": diff },
      });
      return normalize({
        diff,
        keys: [
          Object.keys(diff.added),
          Object.keys(diff.changed),
          Object.keys(diff.removed),
        ],
        prototypes: {
          added: prototype(diff.added),
          changed: prototype(diff.changed),
          removed: prototype(diff.removed),
        },
        changes,
        identities: changes.map((change) => ({
          subpath: change.subpath,
          name: change.name,
          kind: change.kind,
          before: pool.identity(change.before),
          after: pool.identity(change.after),
        })),
      });
    }
    case "changes": {
      const pool = poolOf(input.pool),
        changes = apiChanges(diffOf(input.diff, pool));
      return normalize({
        changes,
        identities: changes.map((change) => ({
          subpath: change.subpath,
          name: change.name,
          kind: change.kind,
          before: pool.identity(change.before),
          after: pool.identity(change.after),
        })),
      });
    }
    case "ratchet": {
      const pool = poolOf(input.pool),
        diff = diffOf(input.diff, pool),
        before = JSON.stringify(diff);
      try {
        const verdict = ratchetApiDiff(diff, input.policy, input.changesets);
        const text = renderApiRatchet(verdict, {
          changes: scalarOf(input.context.changes),
          callout: input.context.callout,
        });
        return normalize({
          verdict,
          text,
          identities: verdict.misses.map((change) => ({
            subpath: change.subpath,
            name: change.name,
            kind: change.kind,
            before: pool.identity(change.before),
            after: pool.identity(change.after),
          })),
          rulesShared: verdict.misses.map((left) =>
            verdict.misses.map((right) => left.needs === right.needs),
          ),
          diffUnchanged: before === JSON.stringify(diff),
        });
      } catch (error) {
        return thrown(error);
      }
    }
    case "render": {
      const pool = poolOf(input.pool);
      const verdict = {
        ...input.verdict,
        misses: input.verdict.misses.map((miss) => ({
          ...miss,
          before: miss.before === null ? null : pool.entry(miss.before),
          after: miss.after === null ? null : pool.entry(miss.after),
        })),
      };
      return {
        text: renderApiRatchet(verdict, {
          changes: scalarOf(input.context.changes),
          callout: input.context.callout,
        }),
        compact: stableStringify(verdict, false),
        pretty: stableStringify(verdict, true),
      };
    }
  }
}
