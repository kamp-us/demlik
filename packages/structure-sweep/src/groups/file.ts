import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { z } from "zod";
import {
  type StageArtifact,
  stageArtifactSchema,
} from "../lowering/artifact.js";
import { ClusterRecord, GROUP_CONFIRM_STAGE } from "../lowering/group.js";
import { TaskSpec } from "../lowering/handoff.js";
import { OWNER_STAGE, OwnerRecord } from "../lowering/owner.js";

/**
 * The stage 6 to 8 artifacts as `structure-sweep groups` reads them: the confirm artifact, the
 * owner artifact (`null` before stage 7 has run), and the task specs. Each artifact keeps the key
 * and digest it was stored under, so the file is the hash-keyed artifacts, not a summary of them.
 */
export const GroupsFile = z.strictObject({
  version: z.literal(1),
  confirmed: stageArtifactSchema(ClusterRecord).refine(
    (a) => a.stage === GROUP_CONFIRM_STAGE,
    { message: `confirmed is the "${GROUP_CONFIRM_STAGE}" artifact` },
  ),
  owners: stageArtifactSchema(OwnerRecord)
    .refine((a) => a.stage === OWNER_STAGE, {
      message: `owners is the "${OWNER_STAGE}" artifact`,
    })
    .nullable(),
  specs: z.array(TaskSpec),
});

export type GroupsFile = z.infer<typeof GroupsFile>;

export class GroupsFileError extends Error {}

/** The groups file for one run of stages 6 to 8. */
export function groupsFileOf(parts: {
  readonly confirmed: StageArtifact<ClusterRecord>;
  readonly owners: StageArtifact<OwnerRecord> | null;
  readonly specs: readonly TaskSpec[];
}): GroupsFile {
  return GroupsFile.parse({ version: 1, ...parts, specs: [...parts.specs] });
}

export function writeGroupsFile(path: string, file: GroupsFile): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(file, null, 1)}\n`);
}

/** Read a groups file, refusing one that is missing, not JSON, or not the stage 6 to 8 artifacts. */
export function readGroupsFile(path: string): GroupsFile {
  if (!existsSync(path))
    throw new GroupsFileError(
      `no groups file at ${path}; write one with writeGroupsFile after running stages 6 to 8`,
    );
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new GroupsFileError(
      `${path} is not JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const parsed = GroupsFile.safeParse(raw);
  if (!parsed.success)
    throw new GroupsFileError(
      `${path} is not a groups file:\n${parsed.error.issues
        .map(
          (i) =>
            `  ${i.path.length === 0 ? "(root)" : i.path.join(".")}: ${i.message}`,
        )
        .join("\n")}`,
    );
  return parsed.data;
}
