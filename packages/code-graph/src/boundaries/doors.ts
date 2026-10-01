import type { ImportEdge } from "../schema.js";
import { nearestName } from "./nearest.js";
import type { ProcessMembers } from "./process-members.js";
import {
  type BoundaryRules,
  type DoorRule,
  featureFileOf,
  type ScopeZoning,
  scopeZoning,
} from "./rules.js";

// A world door is a way a file reaches outside itself: an env var, the terminal, the clock, the
// network, a module that touches the disk. This table is the whole vocabulary, one row per door
// (or per family of doors), and it is the only place a door is named. The detector, the B5 owner
// check and the `rules/` purity check all read it, so adding a door is adding a row here and a
// fixture case beside the detector's test, which the compiler demands.
//
//  - `path`: a static property path read off a global (`Date.now`, `fetch`). Any runtime reference
//    to the path, or to anything below it, is one use.
//  - `members`: a global whose every static member is its own door (`process.<member>`). The row
//    names the family and a use names the member it read, so `process.hrtime()` and
//    `process.hrtime.bigint()` are two reads of one door, `process.hrtime`. Which members exist is
//    Node's to say: a declaration is judged against the running `process`, not a list here.
//  - `bare-new`: `new <ctor>` with no argument (`new Date()` reads the clock; `new Date(x)` does not).
//  - `module`: a runtime import edge naming the module or a subpath of it, with or without `node:`.
type DoorRow =
  | { readonly shape: "path" }
  | { readonly shape: "members"; readonly of: string }
  | { readonly shape: "bare-new"; readonly ctor: string }
  | { readonly shape: "module" };

export const DOORS = {
  "process.<member>": { shape: "members", of: "process" },
  "Date.now": { shape: "path" },
  "Math.random": { shape: "path" },
  "crypto.randomUUID": { shape: "path" },
  "crypto.getRandomValues": { shape: "path" },
  "performance.now": { shape: "path" },
  fetch: { shape: "path" },
  setTimeout: { shape: "path" },
  setInterval: { shape: "path" },
  globalThis: { shape: "path" },
  console: { shape: "path" },
  "new Date()": { shape: "bare-new", ctor: "Date" },
  "node:fs": { shape: "module" },
  "node:child_process": { shape: "module" },
} as const satisfies Record<string, DoorRow>;

// A row of the catalog: `Date.now`, `node:fs`, or the family `process.<member>`.
export type DoorRowName = keyof typeof DOORS;

// A door as a ledger entry and a `doors` declaration spell it: a row's own name, or for a `members`
// row the member a use read (`process.hrtime`). The seven `process` names the catalog once listed
// row by row (`process.env`, `process.cwd`, …) are spelled as they were.
export type DoorName = string;

const ROWS: Readonly<Record<DoorRowName, DoorRow>> = DOORS;

export const DOOR_ROWS = Object.keys(ROWS) as DoorRowName[];

// A chain rooted here is read without the root: `globalThis.process.env.CI` is `process.env.CI`.
export const GLOBAL_OBJECT = "globalThis";

// A door read off a static path: its name is the path's first `prefix.length + members` segments,
// so a `path` row (`members: 0`) is its own prefix and a `members` row adds the member after it.
type PathDoor = { readonly prefix: readonly string[]; readonly members: 0 | 1 };

// Each shape is indexed the way it is looked up: path and member doors by prefix, `new` doors by
// constructor name, module doors by the specifier without `node:`. The switch is exhaustive, so a
// new shape does not compile until it says how it is found.
function indexDoors() {
  const paths: PathDoor[] = [];
  const news = new Map<string, DoorName>();
  const modules = new Map<string, DoorName>();
  for (const door of DOOR_ROWS) {
    const row = ROWS[door];
    switch (row.shape) {
      case "path":
        paths.push({ prefix: door.split("."), members: 0 });
        break;
      case "members":
        paths.push({ prefix: [row.of], members: 1 });
        break;
      case "bare-new":
        news.set(row.ctor, door);
        break;
      case "module":
        modules.set(door.replace(/^node:/, ""), door);
        break;
      default: {
        const exhaustive: never = row;
        return exhaustive;
      }
    }
  }
  return { paths, news, modules };
}

const { paths: PATH_DOORS, news: NEW_DOORS, modules: MODULE_DOORS } = indexDoors();

function startsWith(path: readonly string[], prefix: readonly string[]): boolean {
  return prefix.length <= path.length && prefix.every((segment, index) => path[index] === segment);
}

// The door a static path falls under, or null: `process.stdin.isTTY` falls under `process.stdin`,
// and a bare `process` under none. No row's prefix is a prefix of another's, so there is at most one.
export function pathDoorOf(path: readonly string[]): DoorName | null {
  for (const { prefix, members } of PATH_DOORS) {
    const named = prefix.length + members;
    if (path.length >= named && startsWith(path, prefix)) return path.slice(0, named).join(".");
  }
  return null;
}

export function bareNewDoorOf(ctor: string): DoorName | null {
  return NEW_DOORS.get(ctor) ?? null;
}

// A runtime import of a door module: unresolved inside the scope (a builtin, not a file of the
// scope's own named `fs`) and not type-only, which opens nothing.
export function moduleDoorOf(
  edge: Pick<ImportEdge, "specifier" | "target" | "typeOnly">,
): DoorName | null {
  if (edge.target !== null || edge.typeOnly) return null;
  const [head = ""] = edge.specifier.replace(/^node:/, "").split("/");
  return MODULE_DOORS.get(head) ?? null;
}

// The module doors a file opens when it runs. The edge pass folds `import { type Stats } from "m"`
// into a value import and keeps one edge per specifier, so whether the file runs the module is the
// syntax's answer (`runtime`), and the edge only says where the specifier resolves.
export function moduleDoorsOpened(
  edges: readonly Pick<ImportEdge, "specifier" | "target" | "typeOnly">[],
  runtime: ReadonlySet<string>,
): DoorName[] {
  return edges
    .filter((edge) => runtime.has(edge.specifier))
    .flatMap((edge) => moduleDoorOf(edge) ?? []);
}

// The most specific declared door that is a path prefix of a use: `process.stdin.isTTY` beats
// `process.stdin` for a read of `process.stdin.isTTY`, and `process.stdin` still claims
// `process.stdin.on`.
export function declaredDoorOf(
  path: readonly string[],
  declared: readonly string[],
): string | null {
  let best: { readonly name: string; readonly depth: number } | null = null;
  for (const name of declared) {
    const segments = name.split(".");
    if (startsWith(path, segments) && segments.length > (best?.depth ?? 0)) {
      best = { name, depth: segments.length };
    }
  }
  return best?.name ?? null;
}

const IDENTIFIER = /^[A-Za-z_$][\w$]*$/;

// The rows that name exactly one door. A `members` row names a family, not a door to declare.
const SINGLE_DOORS: ReadonlySet<string> = new Set(
  DOOR_ROWS.filter((row) => ROWS[row].shape !== "members"),
);

// A catalog door, a member of a `members` row (`process.platform`), or a deeper static path under
// either (`process.stdin.isTTY`, `process.hrtime.bigint`), spelled as identifiers.
function isDeclarableDoor(name: string): boolean {
  if (SINGLE_DOORS.has(name)) return true;
  const segments = name.split(".");
  const under = PATH_DOORS.find(
    ({ prefix, members }) =>
      segments.length >= prefix.length + members && startsWith(segments, prefix),
  );
  return (
    under !== undefined && segments.slice(under.prefix.length).every((s) => IDENTIFIER.test(s))
  );
}

// Why a declared door is not one. The root of a `members` family is the near miss worth naming: it
// is the whole family, and an owner names the member it means.
function notADoor(scope: string, door: string): string {
  const family = DOOR_ROWS.find((row) => {
    const shape = ROWS[row];
    return shape.shape === "members" && shape.of === door;
  });
  if (family !== undefined) {
    return (
      `door "${door}" in "${scope}" is the whole family ${family}, not one door: declare the ` +
      "member you mean, or a deeper path under one."
    );
  }
  return (
    `door "${door}" in "${scope}" is not in the door catalog (${DOOR_ROWS.join(", ")}), a member ` +
    "of one of its families, nor a deeper path under a door; a typo would silently enforce nothing."
  );
}

// The family and member a declared door names: `process` and `stdin` for `process.stdin.isTTY`. The
// check ends at the member, because what lies below one is the runtime's, not Node's static shape
// (`process.env` has whatever keys the shell gave it).
function familyMemberOf(door: string): { readonly root: string; readonly member: string } | null {
  const segments = door.split(".");
  for (const { prefix, members } of PATH_DOORS) {
    const member = segments[prefix.length];
    if (members === 1 && member !== undefined && startsWith(segments, prefix)) {
      return { root: prefix.join("."), member };
    }
  }
  return null;
}

// Why a declared door is not one, or null when it is. A member is judged against the `process` the
// CLI runs in, and the refusal names that host's Node version and platform.
function doorProblem(scope: string, door: string, members: ProcessMembers): string | null {
  if (!isDeclarableDoor(door)) return notADoor(scope, door);
  const named = familyMemberOf(door);
  if (named === null || members.names.has(named.member)) return null;
  const near = nearestName(named.member, members.names);
  const hint = near === null ? "" : ` Did you mean ${named.root}.${near}?`;
  const host = `Node ${members.node} (${members.platform})`;
  return `door "${door}" in "${scope}" is not a member of ${named.root} on ${host}.${hint}`;
}

// A zone that judges every door used in it by its own kind has no owner to declare: an owner there
// would be told it may open a door the zone reports anyway.
const OWNERLESS = {
  "door-outside-owner": null,
  "impure-rules": "where no door has an owner",
  "impure-application":
    "where no door has an owner: a hexagonal feature opens a door only in adapters/driven/",
  "door-outside-driven-adapter":
    "where no door has an owner: a hexagonal feature opens a door only in adapters/driven/",
} as const satisfies Record<DoorRule, string | null>;

function ownerProblem(owner: string, zoning: ScopeZoning): string | null {
  const inFeature = featureFileOf(owner, zoning);
  if (inFeature === null) return null;
  const why = OWNERLESS[inFeature.zone.rule.doors];
  if (why === null) return null;
  const root = `src/${inFeature.feature}/${inFeature.zone.entry}`;
  return `is ${owner === root ? root : `under ${root}/`}, ${why}.`;
}

// The doors a rules file may declare, parsed once at the config edge. The first problem, or null.
export function doorDeclarationIssue(rules: BoundaryRules, members: ProcessMembers): string | null {
  for (const [scope, doors] of Object.entries(rules.doors)) {
    if (rules.features[scope] === undefined) {
      return `"doors" declares scope "${scope}", which declares no "features": doors ride a scope that declares features.`;
    }
    const zoning = scopeZoning(rules, scope);
    for (const [door, owners] of Object.entries(doors)) {
      const problem = doorProblem(scope, door, members);
      if (problem !== null) return problem;
      for (const owner of owners) {
        const where = ownerProblem(owner, zoning);
        if (where !== null) return `owner "${owner}" of door "${door}" in "${scope}" ${where}`;
      }
    }
  }
  return null;
}

// Owners that name no file the scope loaded: a stale or mistyped owner would enforce nothing.
export function unknownOwners(
  doors: Readonly<Record<string, readonly string[]>>,
  files: ReadonlySet<string>,
): string[] {
  return Object.entries(doors).flatMap(([door, owners]) =>
    owners.filter((owner) => !files.has(owner)).map((owner) => `${door}: ${owner}`),
  );
}
