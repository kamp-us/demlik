import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type BoundaryRepo, boundaryRepo } from "../../test-helpers/boundary-repo.js";
import {
  INTERPRETER_FILES,
  INTERPRETER_RULES,
  SHOP,
} from "../../test-helpers/shop-interpreters.js";

const QUEUE = INTERPRETER_RULES.interpreters[SHOP].queue;

describe("a declaration the repo cannot honour is refused before anything is judged", () => {
  let repo: BoundaryRepo;
  beforeEach(() => {
    repo = boundaryRepo(".", INTERPRETER_FILES, INTERPRETER_RULES);
  });
  afterEach(() => repo.dispose());

  // The refusal every mode gives: exit 2, one line, nothing on stdout and no ledger written.
  const refused = (interpreters: unknown, extra: Record<string, unknown> = {}): string => {
    const file = path.join(repo.root, "rules.json");
    const { interpreters: _, ...rest } = INTERPRETER_RULES;
    fs.writeFileSync(file, JSON.stringify({ ...rest, ...extra, interpreters }));
    const messages: string[] = [];
    for (const flags of [{}, { ci: true }, { acceptCrossings: true, reason: "x" }]) {
      const { code, errors, stdout } = repo.run({ ...flags, rules: file });
      expect(code).toBe(2);
      expect(stdout).toBe("");
      expect(errors).toHaveLength(1);
      messages.push(...errors);
    }
    expect(fs.existsSync(repo.ledgerFile)).toBe(false);
    return messages[0] ?? "";
  };
  const queue = (entry: Record<string, unknown>) => ({ [SHOP]: { queue: { ...QUEUE, ...entry } } });

  it("names the key and the entry for each declaration the rules file alone can show", () => {
    const cases: readonly [string, unknown, RegExp][] = [
      [
        "a scope with no features",
        { "services/ghost": { queue: QUEUE } },
        /"interpreters" declares scope "services\/ghost", which declares no "features"/,
      ],
      [
        "an empty modules list",
        queue({ modules: [] }),
        /"interpreters" technology "queue" in "services\/shop" lists no "modules" entry/,
      ],
      [
        "a package entry that is not a glob",
        queue({ modules: ["{queue-sdk"] }),
        /"interpreters" module "\{queue-sdk" of technology "queue" in "services\/shop" is not a package glob/,
      ],
      [
        "a root that is a feature folder",
        queue({ root: "src/orders" }),
        /"interpreters" root "src\/orders" of technology "queue".* is the feature folder "src\/orders"/,
      ],
      [
        "a root that holds the feature folders",
        queue({ root: "src" }),
        /"interpreters" root "src" of technology "queue".* holds the feature folder "src\/orders"/,
      ],
      [
        "a root inside a feature folder",
        queue({ root: "src/orders/adapters/queue" }),
        /"interpreters" root "src\/orders\/adapters\/queue" of technology "queue".* sits inside the feature folder "src\/orders"/,
      ],
      [
        "a root that is the lib folder",
        queue({ root: "src/lib" }),
        /"interpreters" root "src\/lib" of technology "queue".* is the lib folder "src\/lib"/,
      ],
      [
        "a root inside the lib folder",
        queue({ root: "src/lib/queue" }),
        /"interpreters" root "src\/lib\/queue" of technology "queue".* sits inside the lib folder "src\/lib"/,
      ],
      [
        "two roots where one holds the other",
        { [SHOP]: { queue: QUEUE, mail: { root: "src/interpreters", modules: ["smtp"] } } },
        /"interpreters" root "src\/interpreters\/queue" of technology "queue".* sits inside the root "src\/interpreters" of technology "mail"/,
      ],
    ];
    for (const [label, interpreters, message] of cases) {
      expect(refused(interpreters), label).toMatch(message);
    }
  });

  it("names the key and the entry for a root or a src/ module the scope does not load", () => {
    expect(refused(queue({ root: "src/interpreters/ghost" }))).toMatch(
      /"interpreters" root "src\/interpreters\/ghost" of technology "queue" in "services\/shop" holds no source file the scope loads/,
    );
    expect(refused(queue({ modules: ["queue-sdk", "src/lib/ghost"] }))).toMatch(
      /"interpreters" module "src\/lib\/ghost" of technology "queue" in "services\/shop" names no file or directory the scope loads/,
    );
  });

  it("refuses a lib folder the rules file renames, as it does the default one", () => {
    expect(refused(queue({ root: "src/shared/queue" }), { lib: ["shared"] })).toMatch(
      /"interpreters" root "src\/shared\/queue" of technology "queue".* sits inside the lib folder "src\/shared"/,
    );
  });
});
