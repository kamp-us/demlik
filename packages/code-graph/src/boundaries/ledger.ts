import fs from "node:fs";
import { z } from "zod";
import { stableStringify } from "../render/json.js";
import { type BoundaryKind, CROSSINGS } from "./violation.js";

export { type BoundaryRules, BoundaryRulesSchema } from "./rules.js";

// `boundary-ledger.json` at the repo root: one entry per boundary crossing a scope still carries.
// The gate fails only on a crossing the ledger does not name, and drops the entries whose crossing
// is gone, so the file only shrinks unless someone adds to it by name and with a reason.
export const LEDGER_FILENAME = "boundary-ledger.json";

export const BOUNDARY_KINDS = Object.keys(CROSSINGS) as BoundaryKind[];

// Whether a kind can cross to something that is not a file of the scope: a bare import
// (`application-import-outside-allowlist`), an impure global or world library (`impure`), a worker
// binding (`binding-outside-driven-adapter`) or an entry (`unknown-zone` of a feature,
// `index-not-exports-only` of an entry file, `library-undeclared` of a package, `worker-call-cycle`
// of workers). Every other kind names its target file, or for an import of a library
// (`library-imports-up`, `adapter-library-imported-outside-driven`) or of another workspace
// (`relative-import-crosses-workspace`) its directory.
const MAY_HAVE_NO_FILE = {
  "adapter-library-imported-outside-driven": false,
  "application-import-outside-allowlist": true,
  "application-imports-adapter": false,
  "binding-outside-driven-adapter": true,
  "cross-feature": false,
  "driving-reaches-driven": false,
  impure: true,
  "index-not-exports-only": true,
  "lib-imports-feature": false,
  "library-imports-up": false,
  "library-undeclared": true,
  "outside-imports-feature-internal": false,
  "relative-import-crosses-workspace": false,
  "unknown-zone": true,
  "worker-call-cycle": true,
} as const satisfies Record<BoundaryKind, boolean>;

const NO_FILE_KINDS = BOUNDARY_KINDS.filter((kind) => MAY_HAVE_NO_FILE[kind]).join(", ");

const EntrySchema = z
  .object({
    scope: z.string().min(1),
    kind: z.enum(BOUNDARY_KINDS),
    from: z.string().min(1),
    to: z.string().min(1).nullable(),
    specifier: z.string().min(1),
    reason: z.string().min(1).optional(),
  })
  .strict()
  .refine((entry) => entry.to !== null || MAY_HAVE_NO_FILE[entry.kind], {
    message:
      "only a bare-specifier import, an impure use or a feature's entry may have a null `to` " +
      `(kinds ${NO_FILE_KINDS})`,
    path: ["to"],
  });

export const BoundaryLedgerSchema = z
  .object({ entries: z.array(EntrySchema).default([]) })
  .strict()
  .superRefine(({ entries }, ctx) => {
    const seen = new Set<string>();
    entries.forEach((entry, index) => {
      const key = ledgerKey(entry);
      if (seen.has(key)) {
        ctx.addIssue({
          code: "custom",
          message: `duplicate entry ${key}`,
          path: ["entries", index],
        });
      }
      seen.add(key);
    });
  });

// `to` is the resolved target file (for an import of a library or of another workspace, its
// directory), or null for a bare import (`application-import-outside-allowlist`), an impure global
// or world library (`impure`), a worker binding (`binding-outside-driven-adapter`) or an entry
// (`unknown-zone`, `index-not-exports-only`, `library-undeclared`, `worker-call-cycle`), in which
// case the target is the specifier itself. `specifier` is how an import was written, or the
// `IMPURE_GLOBALS` row's name, and is display only for a file target: it is not part of the
// identity, so a move that rewrites a relative specifier keeps it.
export type BoundaryLedgerEntry = z.infer<typeof EntrySchema>;
export type BoundaryLedger = { readonly entries: readonly BoundaryLedgerEntry[] };

export type FileMove = { readonly from: string; readonly to: string };

export type LedgerRead =
  | { readonly kind: "absent" }
  | { readonly kind: "read"; readonly ledger: BoundaryLedger }
  | { readonly kind: "invalid"; readonly message: string };

export function ledgerTargetOf(entry: Pick<BoundaryLedgerEntry, "to" | "specifier">): string {
  return entry.to ?? entry.specifier;
}

// The identity: `(scope, kind, from, to ?? specifier)`. Two imports of one target from one file are
// one crossing, and so are two uses of one `IMPURE_GLOBALS` row.
export function ledgerKey(entry: Omit<BoundaryLedgerEntry, "reason">): string {
  return JSON.stringify([entry.scope, entry.kind, entry.from, ledgerTargetOf(entry)]);
}

function compareEntries(a: BoundaryLedgerEntry, b: BoundaryLedgerEntry): number {
  return (
    a.scope.localeCompare(b.scope) ||
    a.kind.localeCompare(b.kind) ||
    a.from.localeCompare(b.from) ||
    ledgerTargetOf(a).localeCompare(ledgerTargetOf(b)) ||
    a.specifier.localeCompare(b.specifier)
  );
}

// Sorted, one entry per key. On a collision the first entry that carries a reason wins, so merging
// never drops the reason someone wrote.
export function boundaryLedgerOf(entries: readonly BoundaryLedgerEntry[]): BoundaryLedger {
  const byKey = new Map<string, BoundaryLedgerEntry>();
  for (const entry of entries) {
    const key = ledgerKey(entry);
    const held = byKey.get(key);
    if (held === undefined || (held.reason === undefined && entry.reason !== undefined)) {
      byKey.set(key, entry);
    }
  }
  return { entries: [...byKey.values()].sort(compareEntries) };
}

export function parseBoundaryLedger(text: string): LedgerRead {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { kind: "invalid", message: "not valid JSON" };
  }
  const result = BoundaryLedgerSchema.safeParse(parsed);
  if (!result.success) {
    const issue = result.error.issues[0];
    return { kind: "invalid", message: `${issue?.path.join(".") || "(root)"}: ${issue?.message}` };
  }
  return { kind: "read", ledger: boundaryLedgerOf(result.data.entries) };
}

export function readBoundaryLedger(file: string): LedgerRead {
  if (!fs.existsSync(file)) return { kind: "absent" };
  return parseBoundaryLedger(fs.readFileSync(file, "utf8"));
}

export function serializeBoundaryLedger(ledger: BoundaryLedger): string {
  return `${stableStringify(boundaryLedgerOf(ledger.entries), true)}\n`;
}

export function writeBoundaryLedger(file: string, ledger: BoundaryLedger): void {
  fs.writeFileSync(file, serializeBoundaryLedger(ledger));
}

// Re-keys every entry whose importer or target file moved. Paths are repo-relative, as the ledger
// writes them; the scope stays. Whether a moved import still crosses is the next gate run's call:
// one that no longer does is pruned there.
export function rekeyBoundaryLedger(
  ledger: BoundaryLedger,
  moves: readonly FileMove[],
): BoundaryLedger {
  const moved = new Map(moves.map((move) => [move.from, move.to]));
  return boundaryLedgerOf(
    ledger.entries.map((entry) => ({
      ...entry,
      from: moved.get(entry.from) ?? entry.from,
      to: entry.to === null ? null : (moved.get(entry.to) ?? entry.to),
    })),
  );
}

export type LedgerFileRekey =
  | { readonly kind: "absent" }
  | { readonly kind: "rekeyed"; readonly entries: number }
  | { readonly kind: "invalid"; readonly message: string };

// The move lane's call: re-key the ledger file in place, in the same commit as the moves. An
// absent ledger is left absent; an unreadable one is left untouched.
export function rekeyBoundaryLedgerFile(file: string, moves: readonly FileMove[]): LedgerFileRekey {
  const read = readBoundaryLedger(file);
  if (read.kind !== "read") return read;
  const rekeyed = rekeyBoundaryLedger(read.ledger, moves);
  const before = new Set(read.ledger.entries.map(ledgerKey));
  const changed = rekeyed.entries.filter((entry) => !before.has(ledgerKey(entry))).length;
  writeBoundaryLedger(file, rekeyed);
  return { kind: "rekeyed", entries: changed };
}
