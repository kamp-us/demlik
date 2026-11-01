/**
 * The cross-process lock under the fenced `fileStore` and `fileJournal`: a file
 * created with `wx` (O_CREAT|O_EXCL), the one primitive atomic across processes.
 *
 * A lock file left behind is judged by what it can prove about its holder. A
 * holder proven gone is stolen; anything else is waited on, up to a limit that
 * ends in a {@link FileLockTimeoutError}. A wrong steal silently loses writes and
 * a loud failure costs one clear step, so every case that proves nothing waits.
 */

import { mkdir, open, readFile, stat, unlink } from "node:fs/promises";
import { hostname, uptime } from "node:os";

/** How long the waits in this module last. Only a test passes other values. */
export interface FileLockLimits {
  /** How long a writer waits for the lock before it gives up. */
  readonly waitMs: number;
  /**
   * How old an empty lock must be to count as a crash, not as a writer between
   * its create and its write. Below `waitMs`, so a crash is stolen within a wait.
   */
  readonly graceMs: number;
}

const DEFAULT_LIMITS: FileLockLimits = { waitMs: 10_000, graceMs: 2_000 };

const SPIN_MS = 10;

/**
 * How far apart two boot times may read and still be one boot. A boot time here
 * is derived from the clock, so one boot reads slightly differently from two
 * moments. Too small a tolerance would rob a live holder; too large only sends a
 * very quick reboot to the loud failure.
 */
const BOOT_TOLERANCE_MS = 60_000;

/** What a lock file says about who holds it. */
type LockHolder =
  /** Nothing yet: a writer between create and write, or a crash in that gap. */
  | { readonly kind: "unwritten" }
  /** The format older versions wrote: a bare process id. */
  | { readonly kind: "pid-only"; readonly pid: number }
  | {
      readonly kind: "stamped";
      readonly host: string;
      readonly bootedAtMs: number;
      readonly pid: number;
    }
  | { readonly kind: "unreadable" };

/** Where this process runs. Read per attempt, because the clock can step. */
interface ThisMachine {
  readonly host: string;
  readonly bootedAtMs: number;
}

/**
 * Why a writer could not take a lock:
 *
 * - `another-host`: the lock names another host, which may still be writing.
 * - `live-holder`: its process is alive on this machine, or its old-format id
 *   names a live process here.
 * - `unwritten`: the lock is empty and too young to count as a crash.
 * - `unreadable`: its contents are not a lock this version can read.
 * - `contended`: no one holder was to blame; other writers kept taking it.
 */
export type FileLockBlock =
  | "another-host"
  | "live-holder"
  | "unwritten"
  | "unreadable"
  | "contended";

const BLOCK_EXPLAINED: Readonly<Record<FileLockBlock, string>> = {
  "another-host":
    "it was written on another host, which may still be writing, so it is not stolen. If that host is gone, delete the file and try again.",
  "live-holder":
    "the process it names is alive. If that process is not a writer here, delete the file and try again.",
  unwritten: "it is empty and too young to count as a crash.",
  unreadable:
    "its contents are not a lock this version can read. If no writer holds it, delete the file and try again.",
  contended: "other writers kept taking it.",
};

/**
 * A write gave up waiting for a lock file. `lockPath` names the file to clear
 * and `blockedBy` says why it could not be taken. The write did not happen.
 */
export class FileLockTimeoutError extends Error {
  override readonly name = "FileLockTimeoutError";
  readonly _tag = "file_lock_timeout" as const;
  constructor(
    readonly lockPath: string,
    readonly waitedMs: number,
    readonly blockedBy: FileLockBlock,
  ) {
    super(
      `@demlik/tea: gave up on lock "${lockPath}" after ${Math.round(waitedMs)} ms: ${BLOCK_EXPLAINED[blockedBy]}`,
    );
  }
}

function thisMachine(): ThisMachine {
  return {
    host: hostname(),
    bootedAtMs: Math.round(Date.now() - uptime() * 1000),
  };
}

function isValidPid(pid: unknown): pid is number {
  return typeof pid === "number" && Number.isSafeInteger(pid) && pid > 0;
}

function parseStamp(body: string): LockHolder {
  let raw: unknown;
  try {
    raw = JSON.parse(body);
  } catch {
    return { kind: "unreadable" };
  }
  if (typeof raw !== "object" || raw === null) return { kind: "unreadable" };
  const { host, bootedAtMs, pid } = raw as Record<string, unknown>;
  if (
    typeof host !== "string" ||
    typeof bootedAtMs !== "number" ||
    !Number.isFinite(bootedAtMs) ||
    !isValidPid(pid)
  ) {
    return { kind: "unreadable" };
  }
  return { kind: "stamped", host, bootedAtMs, pid };
}

function parseHolder(text: string): LockHolder {
  const body = text.trim();
  if (body === "") return { kind: "unwritten" };
  if (/^\d+$/.test(body)) {
    const pid = Number(body);
    return isValidPid(pid) ? { kind: "pid-only", pid } : { kind: "unreadable" };
  }
  return parseStamp(body);
}

/**
 * `process.kill(pid, 0)` sends no signal, it tests existence: it throws `ESRCH`
 * for a dead process and `EPERM` for a live one this process may not signal.
 */
function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** `stale` is a holder proven gone, and nothing else may be stolen. */
function judgeHolder(
  holder: LockHolder,
  ageMs: number,
  here: ThisMachine,
  graceMs: number,
): "stale" | FileLockBlock {
  switch (holder.kind) {
    case "unwritten":
      return ageMs > graceMs ? "stale" : "unwritten";
    case "unreadable":
      return "unreadable";
    case "pid-only":
      return isProcessAlive(holder.pid) ? "live-holder" : "stale";
    case "stamped":
      if (holder.host !== here.host) return "another-host";
      // A process id means nothing across a boot, whoever holds it now.
      if (Math.abs(holder.bootedAtMs - here.bootedAtMs) > BOOT_TOLERANCE_MS) {
        return "stale";
      }
      // One process can hold its own lock from another store, so this process's
      // own id is a live holder like any other.
      return isProcessAlive(holder.pid) ? "live-holder" : "stale";
  }
}

async function ageOf(path: string): Promise<number | "vanished"> {
  try {
    return Date.now() - (await stat(path)).mtimeMs;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return "vanished";
    throw err;
  }
}

/**
 * Read, then age: a writer landing between the two can only make the lock read
 * younger than it is, which holds off a steal.
 */
async function inspectLock(
  lockPath: string,
  limits: FileLockLimits,
): Promise<"vanished" | "stale" | FileLockBlock> {
  let text: string;
  try {
    text = await readFile(lockPath, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return "vanished";
    throw err;
  }
  const ageMs = await ageOf(lockPath);
  if (ageMs === "vanished") return "vanished";
  return judgeHolder(parseHolder(text), ageMs, thisMachine(), limits.graceMs);
}

async function createExclusive(path: string, body: string): Promise<boolean> {
  try {
    const handle = await open(path, "wx");
    try {
      if (body !== "") await handle.writeFile(body);
    } finally {
      await handle.close();
    }
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw err;
  }
}

const removeIfPresent = (path: string): Promise<void> =>
  unlink(path).catch((err: NodeJS.ErrnoException) => {
    if (err.code !== "ENOENT") throw err;
  });

/**
 * Remove a stale lock, or report that this attempt did not.
 *
 * Two writers can both read one dead holder. If each then removed the file, the
 * slower one could remove the lock the faster one just took, and both would
 * hold it. So stealers take turns under a guard file, and each judges the lock
 * again inside it. A guard old enough to be a crash is cleared for the next try.
 */
async function stealIfStillStale(
  lockPath: string,
  limits: FileLockLimits,
): Promise<boolean> {
  const guardPath = `${lockPath}.steal`;
  if (!(await createExclusive(guardPath, ""))) {
    const age = await ageOf(guardPath);
    if (age !== "vanished" && age > limits.graceMs) {
      await removeIfPresent(guardPath);
    }
    return false;
  }
  try {
    const verdict = await inspectLock(lockPath, limits);
    if (verdict === "stale") await removeIfPresent(lockPath);
    return verdict === "stale" || verdict === "vanished";
  } finally {
    await removeIfPresent(guardPath);
  }
}

async function acquireFileLock(
  dir: string,
  lockPath: string,
  limits: FileLockLimits,
): Promise<void> {
  await mkdir(dir, { recursive: true });
  const startedAt = performance.now();
  let blockedBy: FileLockBlock = "contended";
  for (;;) {
    const here = thisMachine();
    const stamp = JSON.stringify({
      host: here.host,
      bootedAtMs: here.bootedAtMs,
      pid: process.pid,
    });
    if (await createExclusive(lockPath, stamp)) return;

    const verdict = await inspectLock(lockPath, limits);
    if (verdict !== "stale" && verdict !== "vanished") blockedBy = verdict;
    const freed =
      verdict === "vanished" ||
      (verdict === "stale" && (await stealIfStillStale(lockPath, limits)));

    const waitedMs = performance.now() - startedAt;
    if (waitedMs >= limits.waitMs) {
      throw new FileLockTimeoutError(lockPath, waitedMs, blockedBy);
    }
    if (!freed) await new Promise((resolve) => setTimeout(resolve, SPIN_MS));
  }
}

/** Run `fx` holding the lock at `lockPath`, and release it afterwards. */
export async function withFileLock<A>(
  dir: string,
  lockPath: string,
  fx: () => Promise<A>,
  limits: FileLockLimits = DEFAULT_LIMITS,
): Promise<A> {
  await acquireFileLock(dir, lockPath, limits);
  try {
    return await fx();
  } finally {
    await unlink(lockPath).catch(() => {});
  }
}
