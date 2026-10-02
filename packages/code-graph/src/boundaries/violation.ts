// What a boundary verdict is: one variant per rule B1-B19, and the two tables that say what kind of
// crossing each is. `analyze.ts` judges a scope into these; the ledger, the report and the
// migration read them.

// An import of a file of the importer's own feature, judged by the importer's zone.
export type ZoneEdge = {
  readonly from: string;
  readonly feature: string;
  readonly to: string;
  readonly specifier: string;
  readonly typeOnly: boolean;
};

// A world door used in a zone that judges it itself: `specifier` is the door.
export type ZoneDoor = {
  readonly from: string;
  readonly feature: string;
  readonly to: null;
  readonly specifier: string;
  readonly typeOnly: false;
};

export type BoundaryViolation =
  | {
      readonly kind: "cross-feature";
      readonly from: string;
      readonly fromFeature: string;
      readonly to: string;
      readonly toFeature: string;
      readonly specifier: string;
      readonly typeOnly: boolean;
    }
  | {
      readonly kind: "impure-rules";
      readonly from: string;
      readonly feature: string;
      readonly to: string | null;
      readonly specifier: string;
      readonly typeOnly: boolean;
      // A world door read by name (`process.env`, `fetch`), not an import. `specifier` is then the
      // door, which an import of a package of that name must not collide with.
      readonly global?: true;
    }
  | {
      readonly kind: "lib-imports-feature";
      readonly from: string;
      readonly to: string;
      readonly toFeature: string;
      readonly specifier: string;
      readonly typeOnly: boolean;
    }
  | {
      readonly kind: "outside-imports-feature-internal";
      readonly from: string;
      readonly to: string;
      readonly toFeature: string;
      readonly specifier: string;
      readonly typeOnly: boolean;
    }
  | {
      readonly kind: "door-outside-owner";
      readonly from: string;
      readonly to: null;
      readonly specifier: string;
      readonly typeOnly: false;
    }
  | ({ readonly kind: "application-imports-adapter" } & ZoneEdge)
  | ({ readonly kind: "impure-application" } & ZoneDoor)
  | ({ readonly kind: "driving-reaches-driven" } & ZoneEdge)
  | ({ readonly kind: "door-outside-driven-adapter" } & ZoneDoor)
  | {
      // An entry of a hexagonal feature that no zone names: `from` is the entry's own path and
      // `specifier` the entry below the feature (`domain`, `adapters/shared`, `helpers.ts`).
      readonly kind: "unknown-zone";
      readonly from: string;
      readonly feature: string;
      readonly to: null;
      readonly specifier: string;
      readonly typeOnly: false;
    }
  | {
      // A package under a declared library root that `libraries` does not name. `from` is the
      // package's directory and `specifier` that directory below the root; the scope is the root.
      readonly kind: "library-undeclared";
      readonly from: string;
      readonly to: null;
      readonly specifier: string;
      readonly typeOnly: false;
    }
  | {
      // An import of a library whose type the importer's type does not list. `to` is the target
      // library's directory: the import resolves to a package, not a file.
      readonly kind: "library-imports-up";
      readonly from: string;
      readonly to: string;
      readonly specifier: string;
      readonly typeOnly: boolean;
    }
  | {
      // A pure library using a world door or importing a world library: `specifier` is the door,
      // or the library as the import wrote it.
      readonly kind: "impure-library";
      readonly from: string;
      readonly to: null;
      readonly specifier: string;
      readonly typeOnly: boolean;
    }
  | {
      // An import of a library that names where it may be imported from, from anywhere else. `to`
      // is the target library's directory.
      readonly kind: "adapter-library-imported-outside-driven";
      readonly from: string;
      readonly to: string;
      readonly specifier: string;
      readonly typeOnly: boolean;
    }
  | {
      // A worker binding its owning worker declares, used in a file outside a hexagonal feature's
      // `adapters/driven/`: `specifier` is the binding's name in the config, one entry per file per
      // binding.
      readonly kind: "binding-outside-driven-adapter";
      readonly from: string;
      readonly to: null;
      readonly specifier: string;
      readonly typeOnly: false;
    }
  | {
      // Two or more workers that bind each other in a loop: `from` the workers, sorted and joined
      // with `, `, and `specifier` the service-binding edges inside the component, one entry per
      // component. A cycle belongs to no one worker, so its scope is the repo's.
      readonly kind: "worker-call-cycle";
      readonly from: string;
      readonly to: null;
      readonly specifier: string;
      readonly typeOnly: false;
    }
  | {
      // A relative import whose target sits in another workspace than the importer. `to` is the
      // target's workspace directory, so however many files of it the importer reaches it is one
      // entry; `specifier` is the first one written.
      readonly kind: "relative-import-crosses-workspace";
      readonly from: string;
      readonly to: string;
      readonly specifier: string;
      readonly typeOnly: boolean;
    };

export type BoundaryKind = BoundaryViolation["kind"];

// What a crossing is: an import edge, a world door used by name or opened (a worker binding used is
// one too), or an entry (a feature's, a package under a library root, a loop of workers) that no
// rule places.
type Crossing = "import" | "door" | "entry";

const CROSSINGS = {
  "adapter-library-imported-outside-driven": "import",
  "application-imports-adapter": "import",
  "binding-outside-driven-adapter": "door",
  "cross-feature": "import",
  "door-outside-driven-adapter": "door",
  "door-outside-owner": "door",
  "driving-reaches-driven": "import",
  "impure-application": "door",
  "impure-library": "door",
  "impure-rules": "import",
  "lib-imports-feature": "import",
  "library-imports-up": "import",
  "library-undeclared": "entry",
  "outside-imports-feature-internal": "import",
  "relative-import-crosses-workspace": "import",
  "unknown-zone": "entry",
  "worker-call-cycle": "entry",
} as const satisfies Record<BoundaryKind, Crossing>;

// A `global` impure-rules entry is a door read by name, not the import its kind otherwise is.
export function crossingOf(entry: {
  readonly kind: BoundaryKind;
  readonly global?: true;
}): Crossing {
  return entry.global === true ? "door" : CROSSINGS[entry.kind];
}

// What `boundary-ceilings.json` never counted: a world door used by name, an import edge it is not.
export function isDoorUse(entry: { readonly kind: BoundaryKind; readonly global?: true }): boolean {
  return crossingOf(entry) === "door";
}
