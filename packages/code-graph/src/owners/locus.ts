import type { Place } from "../boundaries/rules.js";

// Where a file sits, as the view names it: in a feature and the zone there, in a `lib` folder, under
// a technology's interpreter root, or elsewhere in the scope. It is the rules' `Place` without the
// zone row, which is not data.
export type Locus =
  | { readonly kind: "feature"; readonly feature: string; readonly zone: string }
  | { readonly kind: "lib" }
  | { readonly kind: "interpreter"; readonly technology: string }
  | { readonly kind: "elsewhere" };

export function locusOf(place: Place): Locus {
  switch (place.kind) {
    case "feature":
      return { kind: "feature", feature: place.feature, zone: place.zone.name };
    case "interpreter":
      return { kind: "interpreter", technology: place.technology };
    case "lib":
    case "elsewhere":
      return { kind: place.kind };
    default: {
      const exhaustive: never = place;
      return exhaustive;
    }
  }
}

// A binding site sits where a file does, except that the worker's own `main`, where it wires its
// bindings, is a place of its own.
export type SiteLocus = Locus | { readonly kind: "main" };

export function locusText(locus: SiteLocus): string {
  switch (locus.kind) {
    case "feature":
      return `feature ${locus.feature} (${locus.zone})`;
    case "interpreter":
      return `interpreter ${locus.technology}`;
    case "main":
      return "worker main";
    case "lib":
    case "elsewhere":
      return locus.kind;
    default: {
      const exhaustive: never = locus;
      return exhaustive;
    }
  }
}
