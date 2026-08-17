/**
 * Test harness shared by every recipe.
 *
 * Two pieces, both tiny on purpose:
 *
 *   - `memStore` — a `Store<S>` that round-trips through JSON, exactly like the
 *     Durable Object store does. Every recipe's resume test boots a SECOND
 *     runtime from the same cell, so "resume" means "re-parse the bytes", not
 *     "share an object".
 *   - `collect` — a recording `Interpret` for the recipes whose Cmds are
 *     fire-and-forget (send an email, notify an approver). The interesting part
 *     of those recipes is the reducer; the handler layer is a sink.
 */

import type { Cmd, Interpret, Store } from "../../src/index";

/** The persisted bytes. One cell per simulated entity. */
export interface Cell {
  raw: string | null;
}

export function cell(): Cell {
  return { raw: null };
}

export function memStore<S>(
  c: Cell,
  migrate: (raw: unknown) => S | null,
): Store<S> {
  return {
    async load() {
      return c.raw === null ? null : JSON.parse(c.raw);
    },
    async save(state) {
      c.raw = JSON.stringify(state);
    },
    migrate,
  };
}

/**
 * A total `Interpret` that records every Cmd and emits no follow-up Msg. Pass
 * the Cmd type names — totality is checked by the caller's `C["type"]`.
 */
export function collect<M extends { type: string }, C extends Cmd, Ctx>(
  types: readonly C["type"][],
): { readonly cmds: C[]; readonly interpret: Interpret<M, C, Ctx> } {
  const cmds: C[] = [];
  const lowered: Record<string, (cmd: C) => Promise<void>> = {};
  for (const type of types) {
    lowered[type] = async (cmd) => {
      cmds.push(cmd);
    };
  }
  return { cmds, interpret: lowered as unknown as Interpret<M, C, Ctx> };
}
