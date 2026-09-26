/**
 * The consolidation levers, in the order the inventory lists them. `unit` is what an entry's
 * `deletions` counts, so entries compare only within one lever.
 */
export const LEVERS = {
  "dead-export": {
    letter: "A",
    title: "Dead exports",
    unit: "lines",
    reads: "unreachable",
  },
  "tiny-file-merge": {
    letter: "B",
    title: "Tiny-file merges",
    unit: "files",
    reads: "consolidate",
  },
  "same-decision": {
    letter: "C",
    title: "Same decision",
    unit: "lines",
    reads: "pairs",
  },
  "shared-helper": {
    letter: "D",
    title: "Shared helper",
    unit: "lines",
    reads: "pairs",
  },
  "name-twin": {
    letter: "E",
    title: "Exported-name twins",
    unit: "lines",
    reads: "graph",
  },
  "rule-group": {
    letter: "F",
    title: "Rule groups",
    unit: "lines",
    reads: "groups",
  },
} as const;

export type Lever = keyof typeof LEVERS;

/** The input file a lever is built from, by the name its flag carries. */
export type InputName = (typeof LEVERS)[Lever]["reads"];

export const LEVER_ORDER = Object.keys(LEVERS) as readonly Lever[];

/** A pair joins a same-decision group at or above this verdict confidence. */
export const SAME_DECISION_FLOOR = 0.5;

/** A pair joins a shared-helper family at or above this verdict confidence. */
export const SHARED_HELPER_FLOOR = 0.7;

/** How many leading directories of a file name its top-level scope, for exported-name twins. */
export const SCOPE_DEPTH = 2;

/**
 * Exported names too common to mean two scopes made one thing twice: framework entry points,
 * CRUD verbs and lifecycle hooks every module is expected to have.
 */
export const DEFAULT_GENERIC_NAMES: readonly string[] = [
  "DELETE",
  "GET",
  "HEAD",
  "OPTIONS",
  "PATCH",
  "POST",
  "PUT",
  "action",
  "config",
  "create",
  "default",
  "generateMetadata",
  "generateStaticParams",
  "get",
  "handler",
  "index",
  "init",
  "list",
  "load",
  "loader",
  "main",
  "meta",
  "middleware",
  "parse",
  "remove",
  "render",
  "run",
  "set",
  "setup",
  "update",
  "validate",
];
