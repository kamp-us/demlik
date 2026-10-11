import fs from "node:fs";
import path from "node:path";
import { z } from "zod";

// Every input the CLI refuses with exit 2 is one of these, carrying the message the CLI prints
// (SPEC §13.7).
export class ApiInputError extends Error {
  override readonly name = "ApiInputError";
}

const ApiMapEntrySchema = z.strictObject({
  entry: z.string().min(1, "entry must be a non-empty path"),
  tier: z.string().min(1, "tier must be a non-empty string").optional(),
});

// The caller's API map (SPEC §13.2): export subpath → its source entry, relative to the package
// root, and an optional opaque tier. Without its tiers it is #601's `SubpathEntries`.
export const ApiMapSchema = z
  .record(z.string().min(1, "a subpath must be non-empty"), ApiMapEntrySchema)
  .refine((map) => Object.keys(map).length > 0, "the API map names no subpath");

export type ApiMap = z.infer<typeof ApiMapSchema>;

const SOURCE_EXTENSION = /\.(?:ts|tsx|mts|cts)$/;
const DECLARATION_FILE = /\.d\.(?:ts|mts|cts)$/;

// One subpath, checked against the package on disk: its entry is an absolute source file inside
// the package root.
export type ApiSubpath = {
  readonly subpath: string;
  readonly entry: string;
  readonly entryAbsolute: string;
  readonly tier: string | null;
};

// The first schema issue as `<where>: <message>`, the body of a refusal's one line.
export function issueText(error: z.ZodError): string {
  const issue = error.issues[0];
  const where = issue?.path.join(".") || "(root)";
  return `${where}: ${issue?.message ?? "parse error"}`;
}

function checkedSubpath(rootAbsolute: string, subpath: string, entry: string): string {
  const entryAbsolute = path.resolve(rootAbsolute, entry);
  const relative = path.relative(rootAbsolute, entryAbsolute);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new ApiInputError(`API map: ${subpath}: entry ${entry} lies outside ${rootAbsolute}`);
  }
  if (!SOURCE_EXTENSION.test(entry) || DECLARATION_FILE.test(entry)) {
    throw new ApiInputError(
      `API map: ${subpath}: entry ${entry} is not a .ts, .tsx, .mts or .cts source file`,
    );
  }
  if (!fs.existsSync(entryAbsolute) || !fs.statSync(entryAbsolute).isFile()) {
    throw new ApiInputError(`API map: ${subpath}: entry ${entry} does not exist`);
  }
  return entryAbsolute;
}

// Parses `map` through `ApiMapSchema` and checks every entry against the package, in subpath
// order; the first refusal throws `ApiInputError`.
export function apiSubpaths(rootAbsolute: string, map: unknown): readonly ApiSubpath[] {
  const parsed = ApiMapSchema.safeParse(map);
  if (!parsed.success) throw new ApiInputError(`invalid API map: ${issueText(parsed.error)}`);
  return Object.keys(parsed.data)
    .sort()
    .map((subpath) => {
      const { entry, tier } = parsed.data[subpath] as ApiMap[string];
      const entryAbsolute = checkedSubpath(rootAbsolute, subpath, entry);
      return { subpath, entry, entryAbsolute, tier: tier ?? null };
    });
}
