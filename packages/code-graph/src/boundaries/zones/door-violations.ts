import type { ImportEdge } from "../../schema.js";
import { type DoorUse, doorsOf } from "../door-uses.js";
import { declaredDoorOf, moduleDoorsOpened } from "../doors.js";
import { inScope, type Place } from "../rules.js";
import type { BoundaryViolation, ZoneDoor } from "../violation.js";

// The facts of one file the door rules read. `file` is scope-relative.
export type DoorFile = {
  readonly file: string;
  readonly importEdges: readonly Pick<ImportEdge, "specifier" | "target" | "typeOnly">[];
  readonly doorUses: readonly DoorUse[];
  // The specifiers the file opens when it runs: a module door asks this, not the edge.
  readonly runtimeSpecifiers: ReadonlySet<string>;
};

export type DoorContext = {
  readonly scope: string;
  readonly module: DoorFile;
  readonly place: Place;
  readonly doors: Readonly<Record<string, readonly string[]>>;
  // Whether the rules file's `strictDriving` names this scope: a zone that judges the declared
  // doors (B9) then judges every catalog door.
  readonly strict: boolean;
};

function zoneDoor(ctx: DoorContext, feature: string, door: string): ZoneDoor {
  return {
    from: inScope(ctx.scope, ctx.module.file),
    feature,
    to: null,
    specifier: door,
    typeOnly: false,
  };
}

// Inside `rules/` no door has an owner, so every use of any catalog door is the zone's own
// violation, once per door. A door module imported there is already an edge, judged by the zone.
function globalsInRules(ctx: DoorContext, feature: string): BoundaryViolation[] {
  const used = new Set(ctx.module.doorUses.map((use) => use.door));
  return [...used].map((door) => ({
    kind: "impure-rules",
    ...zoneDoor(ctx, feature, door),
    global: true,
  }));
}

// `application/` imports bare packages freely, so a door module it runs is judged here beside the
// doors it uses by name: every catalog door, declared or not, once per door.
function impureApplication(ctx: DoorContext, feature: string): BoundaryViolation[] {
  return doorsOf(ctx.module).map((door) => ({
    kind: "impure-application",
    ...zoneDoor(ctx, feature, door),
  }));
}

// The doors a file uses or opens, once each: a use belongs to the most specific declared door that
// is a path prefix of it. With `every`, a use no declaration claims is a use all the same, and
// takes the catalog's name for it.
function doorsUsed(ctx: DoorContext, every: boolean): string[] {
  const declared = Object.keys(ctx.doors);
  if (declared.length === 0 && !every) return [];
  const opened = moduleDoorsOpened(ctx.module.importEdges, ctx.module.runtimeSpecifiers);
  const uses = [...ctx.module.doorUses, ...opened.map((door) => ({ door, path: [door] }))];
  const named = uses.flatMap(
    (use) => declaredDoorOf(use.path, declared) ?? (every ? use.door : []),
  );
  return [...new Set(named)];
}

// A declared door's use is a violation unless this file is one of that door's owners.
function outsideOwner(ctx: DoorContext): BoundaryViolation[] {
  return doorsUsed(ctx, false)
    .filter((door) => !ctx.doors[door]?.includes(ctx.module.file))
    .map((door) => ({
      kind: "door-outside-owner",
      from: inScope(ctx.scope, ctx.module.file),
      to: null,
      specifier: door,
      typeOnly: false,
    }));
}

// B5, B7 and B9 and the doors B2 reads, by which rule the file's zone says claims a door.
export function doorViolations(ctx: DoorContext): BoundaryViolation[] {
  const { place } = ctx;
  if (place.kind !== "feature") return outsideOwner(ctx);
  const rule = place.zone.rule.doors;
  switch (rule) {
    case "door-outside-owner":
      return outsideOwner(ctx);
    case "impure-rules":
      return globalsInRules(ctx, place.feature);
    case "impure-application":
      return impureApplication(ctx, place.feature);
    case "door-outside-driven-adapter":
      return doorsUsed(ctx, ctx.strict).map((door) => ({
        kind: rule,
        ...zoneDoor(ctx, place.feature, door),
      }));
    default: {
      const exhaustive: never = rule;
      return exhaustive;
    }
  }
}
