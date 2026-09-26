import { createHash } from "node:crypto";
import { z } from "zod";
import { type Fact, factSchema } from "./fact.js";

/**
 * The identity of one stage run: the stage, its version, a hash of its input and the digests of the
 * artifacts it read. An unchanged key is a cache hit, the salsa / Bazel action-key model.
 */
export type ArtifactKey = string & { readonly __brand: "ArtifactKey" };

/** A stage's typed output, stored under the key of the run that produced it. */
export interface StageArtifact<V> {
  readonly stage: string;
  readonly version: string;
  readonly key: ArtifactKey;
  /** A hash of the key and the facts. A downstream stage's key cites this, never the key alone. */
  readonly digest: string;
  readonly facts: readonly Fact<V>[];
}

export interface StageInput {
  /** The text the stage reads. Its hash is part of the key. */
  readonly content: string;
  /** The upstream artifacts the stage reads, in the order it reads them. */
  readonly artifacts: readonly StageArtifact<unknown>[];
}

/** One lowering stage. Bump `version` whenever its prompt, its model or its code changes what it writes. */
export interface Stage<V> {
  readonly name: string;
  readonly version: string;
  readonly run: (input: StageInput) => Promise<readonly Fact<V>[]>;
}

/** Where a stage's artifacts live between runs. */
export interface ArtifactStore<V> {
  get(key: ArtifactKey): StageArtifact<V> | undefined;
  put(artifact: StageArtifact<V>): void;
}

export function memoryArtifactStore<V>(): ArtifactStore<V> {
  const artifacts = new Map<ArtifactKey, StageArtifact<V>>();
  return {
    get: (key) => artifacts.get(key),
    put: (artifact) => {
      artifacts.set(artifact.key, artifact);
    },
  };
}

/** JSON with every object's keys sorted, so equal values hash equal whatever order built them. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) =>
    v !== null && typeof v === "object" && !Array.isArray(v)
      ? Object.fromEntries(
          Object.entries(v).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
        )
      : v,
  );
}

const sha256 = (text: string) =>
  createHash("sha256").update(text).digest("hex");

export const contentHash = (content: string): string => sha256(content);

export function artifactKey(parts: {
  readonly stage: string;
  readonly version: string;
  readonly inputHash: string;
  readonly inputArtifacts: readonly string[];
}): ArtifactKey {
  return sha256(
    canonicalJson([
      parts.stage,
      parts.version,
      parts.inputHash,
      parts.inputArtifacts,
    ]),
  ) as ArtifactKey;
}

/** The schema of a `StageArtifact<V>` whose facts' values parse under `value`, for reading one off disk. */
export const stageArtifactSchema = <T extends z.ZodType>(value: T) =>
  z.strictObject({
    stage: z.string().min(1),
    version: z.string().min(1),
    key: z
      .string()
      .regex(/^[0-9a-f]{64}$/, "an artifact key is a sha-256 hex digest")
      .transform((key) => key as ArtifactKey),
    digest: z.string().regex(/^[0-9a-f]{64}$/),
    facts: z.array(factSchema(value)),
  });

/** How a run was answered: off the store, or by running the stage. */
export type StageRun<V> =
  | { readonly _tag: "hit"; readonly artifact: StageArtifact<V> }
  | { readonly _tag: "computed"; readonly artifact: StageArtifact<V> };

/** Run `stage` over `input`, unless the store already holds the artifact for this exact key. */
export async function runStage<V>(
  store: ArtifactStore<V>,
  stage: Stage<V>,
  input: StageInput,
): Promise<StageRun<V>> {
  const key = artifactKey({
    stage: stage.name,
    version: stage.version,
    inputHash: contentHash(input.content),
    inputArtifacts: input.artifacts.map((a) => a.digest),
  });
  const cached = store.get(key);
  if (cached !== undefined) return { _tag: "hit", artifact: cached };
  const facts = await stage.run(input);
  const artifact: StageArtifact<V> = {
    stage: stage.name,
    version: stage.version,
    key,
    digest: sha256(canonicalJson({ key, facts })),
    facts,
  };
  store.put(artifact);
  return { _tag: "computed", artifact };
}
