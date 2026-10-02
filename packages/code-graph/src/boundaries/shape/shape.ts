import path from "node:path";
import type { BindingCatalog } from "../../extract/wrangler-config.js";
import { globToRegExp } from "../../kinds/glob.js";
import type { SyntaxFile } from "../../syntax/file.js";
import type { BindingSite } from "../deployables/deployables.js";
import { firstWrite, type ReadAllowance, readAllowanceOf } from "../zones/reads.js";
import { firstOffendingForm } from "./entry-file.js";
import { declaresReadAllowance, type ShapeKind, type ShapeRules } from "./schema.js";

// What the six keys about a feature's own files read as, once for the run: the globs compiled, the
// scopes and kinds as sets, and the read allowance beside the wrangler catalog it reads. Every
// question the judgments ask about them is answered from this value and never from the rules file.
export type Shape = {
  readonly kinds: ReadonlySet<ShapeKind>;
  readonly mayImport: ReadonlySet<string>;
  readonly pure: readonly RegExp[];
  readonly tests: readonly RegExp[];
  readonly strict: ReadonlySet<string>;
  readonly allowance: ReadAllowance;
};

export type ShapeRead =
  | { readonly kind: "read"; readonly shape: Shape }
  | { readonly kind: "refused"; readonly message: string };

// Reads the keys, or says in one line why a declared read allowance cannot stand: a worker whose
// wrangler config the run cannot parse has no write site to see, so the allowance would grant
// silently. The catalog is the run's, read once; a rules file that declares no allowance never has
// it read. The globs were checked where the rules file was read.
export function readShape(rules: ShapeRules, catalog: BindingCatalog): ShapeRead {
  if (declaresReadAllowance(rules) && catalog.unparsedConfigs.length > 0) {
    return {
      kind: "refused",
      message:
        `a wrangler config cannot be parsed: ${catalog.unparsedConfigs.join(", ")}. With ` +
        '"readAllowance" declared, a worker whose config is not read has no write site to see, so ' +
        "the allowance would grant silently: fix the file (JSON with comments, or TOML) and run again.",
    };
  }
  return {
    kind: "read",
    shape: {
      kinds: new Set(rules.applicationShape),
      mayImport: new Set(rules.applicationMayImport),
      pure: rules.pureDependencies.map(globToRegExp),
      tests: rules.testFiles.map(globToRegExp),
      strict: new Set(rules.strictDriving),
      allowance: readAllowanceOf(rules.readAllowance, catalog),
    },
  };
}

// The facts of one file that only its syntax tree can say, read where the file is loaded and only
// for the files that need them: the first form that keeps an `index.ts` from being named
// re-exports, and the first data write of a file a read allowance lists.
export type ShapeFacts = {
  readonly offendingForm: string | null;
  readonly firstWrite: BindingSite | null;
};

export function shapeFactsOf(
  shape: Shape,
  scope: string,
  file: string,
  syntax: SyntaxFile,
): ShapeFacts {
  const entry =
    shape.kinds.has("index-not-exports-only") && path.posix.basename(file) === "index.ts";
  return {
    offendingForm: entry ? firstOffendingForm(syntax) : null,
    firstWrite: firstWrite(shape.allowance, scope, file, syntax),
  };
}
