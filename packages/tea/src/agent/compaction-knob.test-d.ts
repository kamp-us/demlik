// Type-level test for `DefineAgentCompaction` (#332). Compiled by `pnpm
// typecheck` (tsc over `src/**` INCLUDES `*.test-d.ts`). Every
// `@ts-expect-error` MUST sit on a line that genuinely fails to type-check;
// every undirected line is a positive case that must compile.
//
// The contract: at least one independent trigger is required.

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

export const byInput: DefineAgentCompaction = { afterInputTokens: 10 };
export const byBytes: DefineAgentCompaction = { afterImageBytes: 10 };
export const byCount: DefineAgentCompaction = { afterImageCount: 2 };
export const byImagesAndInput: DefineAgentCompaction = {
  afterInputTokens: 10,
  afterImageBytes: 100,
  afterImageCount: 2,
  keepTurns: 1,
};

export const byAll: DefineAgentCompaction = {
  afterTurns: 20,
  afterContextTokens: 100,
  afterInputTokens: 80,
  afterImageBytes: 1000,
  afterImageCount: 4,
  keepTurns: 2,
};
