export {
  execFileSync as checkedExecFileSync,
  spawnSync as checkedSpawnSync,
} from "node:child_process";

export interface CheckWorktree {
  root: string;
  target: string;
  evidence: string;
  receiptFile: string;
  remove(originalFailure?: unknown): void;
}
export function createCheckWorktree(
  sourceRoot: string,
  name: string,
  evidenceDirectory?: string,
): CheckWorktree;
export function checkScratchDirectory(prefix: string): string;
export function cargoCheckEnvironment(
  extra?: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv;
export function assertCheckPath(file: string, owner: string): string;
export function checkEvidenceDirectory(
  sourceRoot: string,
  name: string,
): string;
export function ownedCheck(cwd?: string): Omit<CheckWorktree, "remove">;
export function prepareCheckWorktree(
  check: CheckWorktree,
  graph?: boolean,
): void;
