/**
 * @demlik/tea/agent — internal structured-output schema helper.
 *
 * NOT part of the public `./agent` barrel: `schemaFromGuard` is the shared
 * zod-style `parse` throw-wrapper the two owned structured-output schemas
 * (`agentTurnSchema`, `compactionSummarySchema`) are built from. It lives in its
 * own module so both `types.ts` and `compaction.ts` can import it without either
 * re-exporting it (the barrel `index.ts` never re-exports this file, so the
 * helper stays internal).
 */

import type { Schema } from "../llm-call";

/**
 * Build a `Schema<T>` from a type guard — the zod-style `parse` throw-wrapper the
 * llm-call handler relies on, factored so tea's two owned structured-output
 * schemas ({@link agentTurnSchema}, {@link compactionSummarySchema}) share one
 * shape. On a
 * value the guard rejects it throws `structured-output parse failed: not <name>`
 * (a `*_err` at the boundary — errors are data); otherwise it narrows through.
 * `name` is the full noun phrase incl. article ("an AgentTurn").
 */
export function schemaFromGuard<T>(
  guard: (value: unknown) => value is T,
  name: string,
): Schema<T> {
  return {
    parse: (value: unknown): T => {
      if (!guard(value)) {
        throw new Error(`structured-output parse failed: not ${name}`);
      }
      return value;
    },
  };
}
