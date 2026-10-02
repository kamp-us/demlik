import { z } from "zod";

// Where a library of a type may be imported from: a hexagonal feature's `adapters/driven/`, a file
// outside every feature, or anywhere.
const ImportedFromSchema = z.enum(["driven", "configurator", "any"]);
export type ImportedFrom = z.infer<typeof ImportedFromSchema>;

// One library type: the types it may import (its own included, when it says so), whether it must
// stay free of world doors and world libraries, and where it may be imported from. The type names
// are the rules file's; nothing here knows `contract` from `ui`.
const LibraryTypeSchema = z
  .object({
    imports: z.array(z.string().min(1)),
    pure: z.boolean(),
    importedFrom: z.array(ImportedFromSchema).min(1).optional(),
  })
  .strict();
export type LibraryType = z.infer<typeof LibraryTypeSchema>;

// The four keys of the rules file that declare libraries, spread into `BoundaryRulesSchema`.
//  - `libraryTypes`: the types, by name.
//  - `libraries`: a package's repo-relative directory, to its type.
//  - `libraryRoots`: directories whose packages must all appear in `libraries`.
//  - `worldLibraries`: package names (globs allowed) a pure library may not import.
export const LIBRARY_KEYS = {
  libraryTypes: z.record(z.string().min(1), LibraryTypeSchema).default({}),
  libraries: z.record(z.string().min(1), z.string().min(1)).default({}),
  libraryRoots: z.array(z.string().min(1)).default([]),
  worldLibraries: z.array(z.string().min(1)).default([]),
};

export type LibraryRules = z.infer<z.ZodObject<typeof LIBRARY_KEYS>>;

export function declaresLibraries(rules: LibraryRules): boolean {
  return (
    Object.keys(rules.libraryTypes).length > 0 ||
    Object.keys(rules.libraries).length > 0 ||
    rules.libraryRoots.length > 0 ||
    rules.worldLibraries.length > 0
  );
}
