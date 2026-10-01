import type { ImportEdge } from "../schema.js";
import type { BoundaryRules } from "./rules.js";

// A world door is a way a file reaches outside itself: an env var, the terminal, the clock, the
// network, a module that touches the disk. This table is the whole vocabulary, one row per door,
// and it is the only place a door is named. The detector, the B5 owner check and the `rules/`
// purity check all read it, so adding a door is adding a row here and a fixture case beside the
// detector's test, which the compiler demands.
//
//  - `path`: a static property path read off a global (`process.env`, `Date.now`, `fetch`). Any
//    runtime reference to the path, or to anything below it, is one use.
//  - `bare-new`: `new <ctor>` with no argument (`new Date()` reads the clock; `new Date(x)` does not).
//  - `module`: a runtime import edge naming the module or a subpath of it, with or without `node:`.
type DoorRow =
  | { readonly shape: "path" }
  | { readonly shape: "bare-new"; readonly ctor: string }
  | { readonly shape: "module" };

export const DOORS = {
  "process.env": { shape: "path" },
  "process.argv": { shape: "path" },
  "process.stdin": { shape: "path" },
  "process.stdout": { shape: "path" },
  "process.stderr": { shape: "path" },
  "process.exit": { shape: "path" },
  "process.cwd": { shape: "path" },
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

export type DoorName = keyof typeof DOORS;

const ROWS: Readonly<Record<DoorName, DoorRow>> = DOORS;

export const DOOR_NAMES = Object.keys(ROWS) as DoorName[];

// A chain rooted here is read without the root: `globalThis.process.env.CI` is `process.env.CI`.
export const GLOBAL_OBJECT = "globalThis";

type PathDoor = { readonly door: DoorName; readonly segments: readonly string[] };

// Each shape is indexed the way it is looked up: path doors by prefix, `new` doors by constructor
// name, module doors by the specifier without `node:`. The switch is exhaustive, so a new shape
// does not compile until it says how it is found.
function indexDoors() {
  const paths: PathDoor[] = [];
  const news = new Map<string, DoorName>();
  const modules = new Map<string, DoorName>();
  for (const door of DOOR_NAMES) {
    const row = ROWS[door];
    switch (row.shape) {
      case "path":
        paths.push({ door, segments: door.split(".") });
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

// The catalog door a static path falls under, or null. No door is a path prefix of another, so
// there is at most one.
export function pathDoorOf(path: readonly string[]): DoorName | null {
  return PATH_DOORS.find(({ segments }) => startsWith(path, segments))?.door ?? null;
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

// A catalog door, or a deeper static path under a `path` door (`process.stdin.isTTY`).
function isDeclarableDoor(name: string): boolean {
  if (Object.hasOwn(ROWS, name)) return true;
  const segments = name.split(".");
  const under = PATH_DOORS.find(
    (door) => segments.length > door.segments.length && startsWith(segments, door.segments),
  );
  return (
    under !== undefined && segments.slice(under.segments.length).every((s) => IDENTIFIER.test(s))
  );
}

// The doors a rules file may declare, parsed once at the config edge. The first problem, or null.
export function doorDeclarationIssue(rules: BoundaryRules): string | null {
  for (const [scope, doors] of Object.entries(rules.doors)) {
    const features = rules.features[scope];
    if (features === undefined) {
      return `"doors" declares scope "${scope}", which declares no "features": doors ride a scope that declares features.`;
    }
    for (const [door, owners] of Object.entries(doors)) {
      if (!isDeclarableDoor(door)) {
        return (
          `door "${door}" in "${scope}" is not in the door catalog (${DOOR_NAMES.join(", ")}) ` +
          "nor a deeper path under one of its member doors; a typo would silently enforce nothing."
        );
      }
      for (const owner of owners) {
        const zone = features.find((feature) => owner.startsWith(`src/${feature}/rules/`));
        if (zone !== undefined) {
          return `owner "${owner}" of door "${door}" in "${scope}" is under src/${zone}/rules/, where no door has an owner.`;
        }
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
