// ═══════════════════════════════════════════════════════════════════════════
// A DOOR CARRIES EVERY MODULE BEHIND IT — BY SYMBOL, NOT BY NAME.
//
// The seven `battery` doors (#205) are re-export files over `src/internal/`,
// and the two ways one silently stops carrying a module are both quiet:
//
//   - `export *` from two modules that declare the SAME name is `TS2308`, so
//     the honest fix is to name a winner. The dishonest one is to star one
//     module and enumerate the other, which compiles, picks a winner nobody
//     chose, and leaves the loser's type unreachable under its own name.
//   - a hand-enumerated module (this door has one: `resilient-call`) drifts
//     the moment someone adds an export to it. Nothing fails; the name is
//     simply not on the door.
//
// So the check is per SYMBOL, not per name: every symbol a module behind a
// door exports must be reachable through that door, under its own name or a
// rename this file records. Comparing names would pass a door that exports the
// right spelling of the wrong declaration — which is exactly the `TS2308` fix
// done wrong.
//
// The module list is the ruling's table, transcribed. Deriving it from the door
// file instead would make a module dropped from the door invisible here, which
// is the failure this file exists to catch.
// ═══════════════════════════════════════════════════════════════════════════
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Door → the modules it re-exports, from the ruling on #205. A path is
 * relative to `src/`, so it names the file a reader opens.
 */
const DOORS: ReadonlyMap<string, readonly string[]> = new Map([
  [
    "idempotency",
    [
      "internal/idempotency/idempotency",
      "internal/idempotency/idempotent-intake",
    ],
  ],
  [
    "flow",
    [
      "internal/flow/await-terminal",
      "internal/flow/batch-window",
      "internal/flow/fan-out",
      "internal/flow/monitored-run",
      "internal/flow/poller",
      "internal/flow/reconciler",
      "internal/flow/saga",
      "internal/flow/workflow",
    ],
  ],
  [
    "resilience",
    [
      "internal/resilience/authed-call",
      "internal/resilience/cache",
      "internal/resilience/circuit-breaker",
      "internal/resilience/deadline",
      "internal/resilience/rate-limit",
      "internal/resilience/resilient-call",
      "internal/resilience/retry-to-success",
      "internal/resilience/token-refresh",
      "internal/resilience/with-deadline",
      "internal/resilience/with-resilience",
      "internal/resilience/with-telemetry",
    ],
  ],
  [
    "timing",
    [
      "internal/timing/debounce",
      "internal/timing/throttle",
      "internal/timing/throttled-input",
    ],
  ],
  [
    "persistence",
    [
      "internal/persistence/recorder",
      "internal/persistence/snapshot",
      "internal/persistence/trace-replay",
    ],
  ],
  [
    "paginate",
    ["internal/paginate/paginator", "internal/paginate/paginated-walk"],
  ],
  [
    "work-queue",
    [
      "internal/work-queue",
      "internal/work-queue/ops.ts",
      "internal/work-queue/adapter.ts",
    ],
  ],
]);

/**
 * The renames a door applies, `door → module-side name → door-side name`.
 * Every entry here is a collision the door had to resolve, and recording it is
 * what keeps "renamed deliberately" distinguishable from "quietly dropped".
 */
const RENAMED: ReadonlyMap<string, ReadonlyMap<string, string>> = new Map([
  [
    "resilience",
    new Map([
      [
        "DeadlineConfig@internal/resilience/resilient-call",
        "ResilientCallDeadlineConfig",
      ],
    ]),
  ],
]);

/** `src/`-relative module path → the file that path means. */
function sourceFileFor(relPath: string): string {
  const base = join(REPO_ROOT, "src", relPath);
  return relPath.endsWith(".ts") ? base : join(base, "index.ts");
}

const entryFiles = [
  ...[...DOORS.keys()].map((door) => join(REPO_ROOT, "src", door, "index.ts")),
  ...[...DOORS.values()].flat().map(sourceFileFor),
];

const config = ts.parseJsonConfigFileContent(
  ts.readConfigFile(join(REPO_ROOT, "tsconfig.json"), ts.sys.readFile).config,
  ts.sys,
  REPO_ROOT,
);
const program = ts.createProgram(entryFiles, {
  ...config.options,
  noEmit: true,
});
const checker = program.getTypeChecker();

/** The declaration a re-export ultimately names — the symbol's identity. */
function declared(symbol: ts.Symbol): ts.Symbol {
  return symbol.flags & ts.SymbolFlags.Alias
    ? checker.getAliasedSymbol(symbol)
    : symbol;
}

/** `name → declaration` for every export of the module at `file`. */
function exportsOf(file: string): Map<string, ts.Symbol> {
  const source = program.getSourceFile(file);
  if (!source) throw new Error(`battery doors: no source file for ${file}`);
  const moduleSymbol = checker.getSymbolAtLocation(source);
  if (!moduleSymbol) throw new Error(`battery doors: ${file} is not a module`);
  return new Map(
    checker
      .getExportsOfModule(moduleSymbol)
      .map((symbol) => [symbol.getName(), declared(symbol)]),
  );
}

/** Where a symbol is declared, as a repo-relative path — for the failure text. */
function declaredIn(symbol: ts.Symbol): string {
  const decl = symbol.getDeclarations()?.[0];
  return decl ? relative(REPO_ROOT, decl.getSourceFile().fileName) : "?";
}

describe.each([...DOORS])("@demlik/tea/%s", (door, modules) => {
  const doorExports = exportsOf(join(REPO_ROOT, "src", door, "index.ts"));
  const renames = RENAMED.get(door) ?? new Map<string, string>();

  it.each(modules)("carries every export of src/%s", (relPath) => {
    const unreachable: string[] = [];
    for (const [name, symbol] of exportsOf(sourceFileFor(relPath))) {
      const expected = renames.get(`${name}@${relPath}`) ?? name;
      const onDoor = doorExports.get(expected);
      if (onDoor === undefined) {
        unreachable.push(`${name} — no \`${expected}\` on the door`);
      } else if (onDoor !== symbol) {
        unreachable.push(
          `${name} — the door's \`${expected}\` is ${declaredIn(onDoor)}, not ${declaredIn(symbol)}`,
        );
      }
    }
    expect(unreachable).toEqual([]);
  });
});
