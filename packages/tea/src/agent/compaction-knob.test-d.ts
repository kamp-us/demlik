// Type-level test for `DefineAgentCompaction` (#332). Compiled by `pnpm
// typecheck` (tsc over `src/**` INCLUDES `*.test-d.ts`). Every
// `@ts-expect-error` MUST sit on a line that genuinely fails to type-check;
// every undirected line is a positive case that must compile.
//
// The contract: a compaction budget names a turn trigger, a token trigger, or
// both. One naming neither could never fire, so it does not compile.

import type { DefineAgentCompaction } from "./index";

export const byTurns: DefineAgentCompaction = { afterTurns: 20 };
export const byTokens: DefineAgentCompaction = { afterContextTokens: 800_000 };
export const byBoth: DefineAgentCompaction = {
  afterTurns: 20,
  afterContextTokens: 800_000,
  keepTurns: 4,
};

// @ts-expect-error — no trigger at all.
export const empty: DefineAgentCompaction = {};

// @ts-expect-error — `keepTurns` alone says what survives a fold, never when.
export const keepOnly: DefineAgentCompaction = { keepTurns: 2 };
