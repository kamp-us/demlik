import { z } from "zod";
import { globToRegExp } from "./glob.js";

// The export name a convention writes for a module's default export, whatever its local name.
export const DEFAULT_EXPORT = "default";

// An entrypoint-export convention: in a file whose package-relative path matches `files`, an
// export named in `exports` is called by a framework, so it is an entry. Only the listed names
// are: a helper exported beside them is judged like any other export.
export const EntryExportConventionSchema = z
  .object({
    files: z.string().min(1),
    exports: z.array(z.string().min(1)).min(1),
  })
  .strict();
export type EntryExportConvention = z.infer<typeof EntryExportConventionSchema>;

export type EntryExportConventions = Readonly<Record<string, EntryExportConvention>>;

export type CompiledConvention = {
  readonly name: string;
  readonly files: RegExp;
  readonly exports: ReadonlySet<string>;
};

export function compileConventions(conventions: EntryExportConventions): CompiledConvention[] {
  return Object.keys(conventions)
    .sort((a, b) => a.localeCompare(b))
    .flatMap((name) => {
      const convention = conventions[name];
      if (convention === undefined) return [];
      return [
        { name, files: globToRegExp(convention.files), exports: new Set(convention.exports) },
      ];
    });
}

// The names of every convention that makes one of `exportNames` an entry in the file at
// `packagePath` (relative to the package that owns it), sorted and without repeats.
export function matchingConventions(
  conventions: readonly CompiledConvention[],
  packagePath: string,
  exportNames: readonly string[],
): string[] {
  const out = new Set<string>();
  for (const convention of conventions) {
    if (!convention.files.test(packagePath)) continue;
    if (exportNames.some((name) => convention.exports.has(name))) out.add(convention.name);
  }
  return [...out].sort((a, b) => a.localeCompare(b));
}
