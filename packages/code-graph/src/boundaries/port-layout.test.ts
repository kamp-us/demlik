import fs from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { type BoundaryRepo, boundaryRepo } from "../test-helpers/boundary-repo.js";
import { SHOP_TSCONFIG } from "../test-helpers/shop-workspace.js";
import { ledgerTargetOf } from "./ledger.js";
import type { BoundaryViolation } from "./violation.js";

const API = "services/api";
const SRC = `${API}/src`;

const lines = (...source: string[]): string => `${source.join("\n")}\n`;

let repo: BoundaryRepo | null = null;
const open = (files: Record<string, string>, rules: unknown): BoundaryRepo => {
  repo = boundaryRepo(".", files, rules);
  return repo;
};
afterEach(() => repo?.dispose());

function crossingsOf(run: BoundaryRepo): string[][] {
  const parsed: { scopes: { violations: BoundaryViolation[] }[] } = JSON.parse(
    run.run({ json: true }).stdout,
  );
  return parsed.scopes
    .flatMap((scope) => scope.violations)
    .map((v) => [v.kind, v.from.replace(`${SRC}/`, ""), ledgerTargetOf(v).replace(`${SRC}/`, "")]);
}

const MAIL = "driven-adapters/for-sending/mail/mail.ts";

const SERVICE: Record<string, string> = {
  "tsconfig.json": SHOP_TSCONFIG,
  [`${API}/package.json`]: JSON.stringify({ name: "@shop/api" }),
  [`${API}/wrangler.jsonc`]: JSON.stringify({
    name: "api",
    main: "src/worker.ts",
    services: [{ binding: "MAIL", service: "mailer" }],
  }),
  [`${SRC}/worker.ts`]: lines(
    'import { send } from "./application/use-cases/send";',
    'import type { Sender } from "./application/driving-ports/for-sending/sender";',
    'import { handle } from "./driving-adapters/for-http/http";',
    `import { mail } from "./${MAIL.replace(".ts", "")}";`,
    'export const wire = (env: Env, s: Sender) => [send, handle, mail, s, env.MAIL.fetch("/wire")];',
  ),
  [`${SRC}/application/driving-ports/for-sending/sender.ts`]: "export type Sender = () => void;\n",
  [`${SRC}/application/driven-ports/for-sending/mailer.ts`]: "export type Mailer = () => void;\n",
  [`${SRC}/application/use-cases/send.ts`]: lines(
    'import type { Mailer } from "../driven-ports/for-sending/mailer";',
    'import { mail } from "../../driven-adapters/for-sending/mail/mail";',
    "export const send = (m: Mailer) => [m, mail];",
  ),
  [`${SRC}/application/use-cases/bad.ts`]:
    'export const bad = (env: Env) => env.MAIL.fetch("/bad");\n',
  [`${SRC}/driving-adapters/for-http/http.ts`]: lines(
    'import type { Sender } from "../../application/driving-ports/for-sending/sender";',
    'import { send } from "../../application/use-cases/send";',
    'import { mail } from "../../driven-adapters/for-sending/mail/mail";',
    "export const handle = (s: Sender) => [s, send, mail];",
  ),
  [`${SRC}/${MAIL}`]: lines(
    'import type { Mailer } from "../../../application/driven-ports/for-sending/mailer";',
    "export const mail = (env: Env): Mailer => () => void env.MAIL.fetch('/mail');",
  ),
};

const PORT_RULES = {
  features: { [API]: ["application", "driving-adapters", "driven-adapters"] },
  acrossDeployables: ["binding-outside-driven-adapter"],
};

describe("a service in the port layout is judged by the zones a per-feature one is", () => {
  it("reports an application importing an adapter and a driving adapter reaching in, and nothing else", () => {
    expect(crossingsOf(open(SERVICE, PORT_RULES))).toEqual([
      ["application-imports-adapter", "application/use-cases/send.ts", MAIL],
      ["binding-outside-driven-adapter", "application/use-cases/bad.ts", "MAIL"],
      [
        "driving-reaches-driven",
        "driving-adapters/for-http/http.ts",
        "application/use-cases/send.ts",
      ],
      ["driving-reaches-driven", "driving-adapters/for-http/http.ts", MAIL],
    ]);
  });
});

describe("a port layout's declarations name its zones", () => {
  const refused = (rules: unknown): string => {
    const run = open(SERVICE, rules);
    const result = run.run({ acceptCrossings: true, reason: "r" });
    expect(result.code).toBe(2);
    expect(result.stdout).toBe("");
    expect(result.errors).toHaveLength(1);
    expect(fs.existsSync(run.ledgerFile)).toBe(false);
    return result.errors[0] ?? "";
  };
  const accepted = (rules: unknown): void => {
    const result = open(SERVICE, rules).run();
    expect(result.errors).toEqual([]);
    expect(result.code).toBe(0);
  };

  it("refuses a scope that lists a port-layout folder and a feature folder", () => {
    const message = refused({ features: { [API]: ["application", "orders"] } });
    expect(message).toContain(`"features" in "${API}"`);
    expect(message).toContain("port-layout folder(s) application");
    expect(message).toContain("feature folder(s) orders");
  });

  it("accepts a binding owner under driven-adapters/ and refuses one in application/", () => {
    accepted({ ...PORT_RULES, bindingOwners: { [API]: { MAIL: [`src/${MAIL}`] } } });
    const message = refused({
      ...PORT_RULES,
      bindingOwners: { [API]: { MAIL: ["src/application/use-cases/send.ts"] } },
    });
    expect(message).toContain("src/<feature>/adapters/driven/ (per-feature layout)");
    expect(message).toContain("src/driven-adapters/ (port layout)");
  });

  it("accepts a read allowance on a file under driven-adapters/", () => {
    accepted({ ...PORT_RULES, readAllowance: { [API]: { driven: [`src/${MAIL}`] } } });
  });
});

describe("the port layout reads the impure zones", () => {
  it("reports impure globals everywhere in the hexagon but driven-adapters/", () => {
    const files = {
      "tsconfig.json": SHOP_TSCONFIG,
      [`${SRC}/application/use-cases/env.ts`]: "export const env = process.env.A;\n",
      [`${SRC}/application/driving-ports/for-x/get.ts`]: 'export const get = () => fetch("/a");\n',
      [`${SRC}/application/driven-ports/for-x/put.ts`]: "export const put = process.env.B;\n",
      [`${SRC}/driving-adapters/for-x/route.ts`]: 'export const route = () => fetch("/b");\n',
      [`${SRC}/driven-adapters/for-x/db.ts`]: "export const db = process.env.C;\n",
    };
    expect(crossingsOf(open(files, { features: PORT_RULES.features }))).toEqual([
      ["impure", "application/driven-ports/for-x/put.ts", "process.env"],
      ["impure", "application/driving-ports/for-x/get.ts", "fetch"],
      ["impure", "application/use-cases/env.ts", "process.env"],
      ["impure", "driving-adapters/for-x/route.ts", "fetch"],
    ]);
  });
});

describe("the per-feature layout keeps reading an adapters/ folder as adapters", () => {
  it("reports an application importing a folder of adapters/ that no zone names", () => {
    const files = {
      "tsconfig.json": SHOP_TSCONFIG,
      [`${SRC}/orders/application/use.ts`]:
        'import { retry } from "../adapters/shared/retry";\nexport const use = retry;\n',
      [`${SRC}/orders/adapters/shared/retry.ts`]: "export const retry = 1;\n",
    };
    expect(crossingsOf(open(files, { features: { [API]: ["orders"] } }))).toEqual([
      [
        "application-imports-adapter",
        "orders/application/use.ts",
        "orders/adapters/shared/retry.ts",
      ],
      ["unknown-zone", "orders/adapters/shared", "adapters/shared"],
    ]);
  });
});
