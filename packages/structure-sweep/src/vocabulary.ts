import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { z } from "zod";

/** Where `sweep` and `move plan` look for the vocabulary when `--config` names no file. */
export const DEFAULT_CONFIG_FILE = "structure-sweep.config.json";

const Key = z
  .string()
  .regex(
    /^[a-z][a-z0-9_]*$/,
    "a key is lower_snake_case: a-z, 0-9 and _, starting with a letter",
  );

const Description = z
  .string()
  .trim()
  .min(1, "a description says what belongs here");

const Segment = z
  .string()
  .regex(
    /^[a-z0-9][a-z0-9._-]*$/,
    "a folder name is one lowercase path segment",
  );

const Role = z.strictObject({
  description: Description,
  /** The folder a file with this role lands in. */
  dir: Segment,
  /** `true` puts the folder at `<scope>/src/<dir>`, shared by every feature, instead of under one. */
  shared: z.boolean().default(false),
});

const atLeastTwo = (what: string) => ({
  message: `name at least two ${what}; one option is not a choice`,
});

const twoOrMore = (record: Readonly<Record<string, unknown>>) =>
  Object.keys(record).length >= 2;

export const VocabularyConfig = z.strictObject({
  /** One line on what the codebase is, so Jev reads a file against the right product. */
  product: Description.optional(),
  features: z
    .record(Key, Description)
    .refine(twoOrMore, atLeastTwo("features")),
  roles: z.record(Key, Role).refine(twoOrMore, atLeastTwo("roles")),
});

export type VocabularyConfig = z.infer<typeof VocabularyConfig>;
export type RoleConfig = VocabularyConfig["roles"][string];

/**
 * A parsed vocabulary. `fingerprint` changes whenever anything Jev is asked against changes, so a
 * cached answer is reused only under the vocabulary it was given.
 */
export interface Vocabulary extends VocabularyConfig {
  readonly fingerprint: string;
}

export class VocabularyError extends Error {}

export function parseVocabulary(
  raw: unknown,
  source = "vocabulary",
): Vocabulary {
  const parsed = VocabularyConfig.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues.map(
      (i) =>
        `  ${i.path.length === 0 ? "(root)" : i.path.join(".")}: ${i.message}`,
    );
    throw new VocabularyError(
      `${source} is not a valid vocabulary:\n${issues.join("\n")}`,
    );
  }
  const fingerprint = createHash("sha256")
    .update(JSON.stringify(parsed.data))
    .digest("hex")
    .slice(0, 16);
  return { ...parsed.data, fingerprint };
}

export function loadVocabulary(path: string): Vocabulary {
  if (!existsSync(path)) {
    throw new VocabularyError(
      `no vocabulary at ${path}; write one (see the README) or pass --config <file>`,
    );
  }
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new VocabularyError(
      `${path} is not JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return parseVocabulary(raw, path);
}

export const isFeature = (vocabulary: Vocabulary, value: string): boolean =>
  Object.hasOwn(vocabulary.features, value);

export const roleOf = (
  vocabulary: Vocabulary,
  value: string,
): RoleConfig | undefined =>
  Object.hasOwn(vocabulary.roles, value) ? vocabulary.roles[value] : undefined;
