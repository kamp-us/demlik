import { MAX_RESUME_ATTEMPTS, RESUME_BACKOFF_MAX_S } from "./limits.js";

type Decision = { kind: "give_up"; reason: string } | { kind: "retry"; backoffS: number };

export function decideResume(input: {
  attemptsAfter: number;
  maxAttempts: number;
  maxS: number;
  terminalReason: string;
}): Decision {
  if (input.attemptsAfter >= input.maxAttempts) {
    return { kind: "give_up", reason: input.terminalReason };
  }
  return { kind: "retry", backoffS: Math.min(input.maxS, 2 ** input.attemptsAfter) };
}

export function noteResumeAttemptCount(state: { attempts: number }): number {
  state.attempts += 1;
  return state.attempts;
}

export function finalizeFailed(reason: string): string {
  return `failed: ${reason}`;
}

export function salvageCheckpoint(reason: string): string {
  return `partial: ${reason}`;
}

export function armGiveUpTimer(seconds: number): number {
  return seconds;
}

export function reDispatchOrGiveUp(state: { attempts: number }, terminalReason: string): string {
  const attemptsAfter = noteResumeAttemptCount(state);
  const decision = decideResume({
    attemptsAfter,
    maxAttempts: MAX_RESUME_ATTEMPTS,
    maxS: RESUME_BACKOFF_MAX_S,
    terminalReason,
  });
  console.log(`resume ${attemptsAfter}`);
  if (decision.kind === "give_up") {
    return finalizeFailed(decision.reason);
  }
  return String(armGiveUpTimer(decision.backoffS));
}

export function recoverTransientGraphStep(state: { attempts: number }, err: unknown): string {
  if (err instanceof RangeError) {
    return salvageCheckpoint("repeat timeout");
  }
  const attemptsAfter = noteResumeAttemptCount(state);
  const decision = decideResume({
    attemptsAfter,
    maxAttempts: MAX_RESUME_ATTEMPTS,
    maxS: RESUME_BACKOFF_MAX_S,
    terminalReason: "graph_error",
  });
  console.log(`recover ${attemptsAfter}`);
  if (decision.kind === "give_up") {
    return salvageCheckpoint(decision.reason);
  }
  return String(armGiveUpTimer(decision.backoffS));
}
