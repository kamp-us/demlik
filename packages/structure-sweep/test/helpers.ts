import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type {
  JevChoiceAnswer,
  JevOk,
  JevQuestionMap,
  JevState,
} from "@demlik/tea/jev";
import type { JevClient } from "../src/jev.js";
import { loadVocabulary } from "../src/vocabulary.js";

export const fixtureVocabulary = () =>
  loadVocabulary(join(import.meta.dirname, "fixtures/saas-audit.config.json"));

export function write(
  root: string,
  files: Readonly<Record<string, string>>,
): void {
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
}

export function gitIn(root: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd: root, encoding: "utf8" });
}

/** A committed git repository holding `files`, in a fresh temp directory. */
export function repo(files: Readonly<Record<string, string>>): string {
  const root = mkdtempSync(join(tmpdir(), "structure-sweep-"));
  gitIn(root, "init", "-q", "-b", "main");
  gitIn(root, "config", "user.email", "test@example.com");
  gitIn(root, "config", "user.name", "test");
  gitIn(root, "config", "commit.gpgsign", "false");
  write(root, files);
  commit(root, "init");
  return root;
}

export function commit(root: string, message: string): void {
  gitIn(root, "add", "-A");
  gitIn(root, "commit", "-q", "--allow-empty", "-m", message);
}

export function choice<K extends string>(
  key: K,
  keys: readonly string[],
): JevChoiceAnswer<K> {
  return {
    type: "choice",
    choice: key,
    confidence: 0.9,
    probabilities: Object.fromEntries(
      keys.map((k) => [k, k === key ? 0.9 : 0]),
    ) as Record<K, number>,
  };
}

/** A Jev stand-in that answers with `answer(state)` and records every state it was asked about. */
export function stubJev<Q extends JevQuestionMap>(
  answer: (state: JevState) => JevOk<Q>["answers"],
): JevClient<Q> & { readonly asked: JevState[] } {
  const asked: JevState[] = [];
  const client = async (state: JevState): Promise<JevOk<Q>> => {
    asked.push(state);
    return {
      answers: answer(state),
      model: "jev-stub",
      usage: { input_tokens: 10, output_tokens: 1 },
      source: "port",
    };
  };
  return Object.assign(client, { asked });
}
