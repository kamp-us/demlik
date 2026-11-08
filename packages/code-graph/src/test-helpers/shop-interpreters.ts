import path from "node:path";
import { shopManifests } from "./shop-workspace.js";

// The synthetic workspace the interpreter rules are tested against: two scopes of one repo. `SHOP`
// is per-feature, with the features `orders`, `billing` and `shipping`; `MAIL` is the port layout.
// Both declare one interpreter, for the technology `queue`, whose modules are the package
// `queue-sdk` and the path `src/lib/queue-client`. A second technology, `git`, is a local effect no
// interpreter covers, so the adapters that use it must stay clean. Every name is made up.
//
// It plants nineteen B22 crossings, fifteen in `SHOP` (five files of each feature) and four in
// `MAIL`, and clean files beside them that import the same modules and must produce nothing.

export const SHOP = "services/shop";
export const MAIL = "services/mail";
const FEATURES = ["orders", "billing", "shipping"] as const;

const PACKAGE = "queue-sdk";
const CLIENT = "src/lib/queue-client";

// One import form of the queue modules: `m` is how the file spells the module.
const FORMS = {
  static: (m: string) => `import { enqueue } from "${m}";\nexport const a = enqueue;`,
  type: (m: string) => `import type { Job } from "${m}";\nexport type A = Job;`,
  reexport: (m: string) => `export { enqueue as b } from "${m}";`,
  reexportType: (m: string) => `export type { Job as C } from "${m}";`,
  dynamic: (m: string) => `export const d = () => import("${m}");`,
  typeImport: (m: string) => `export type E = import("${m}").Job;`,
  require: (m: string) => `import q = require("${m}");\nexport const f = q;`,
} as const;

type Form = keyof typeof FORMS;
const ALL: readonly Form[] = Object.keys(FORMS) as Form[];

// A scope-relative file spelling `to` the way a relative import from `from` would.
function relative(from: string, to: string): string {
  const spelled = path.posix.relative(path.posix.dirname(from), to);
  return spelled.startsWith(".") ? spelled : `./${spelled}`;
}

type Via = "package" | "path";

// A file importing the queue modules in the given forms, through the package or through the path.
function importing(
  scope: string,
  file: string,
  via: Via,
  forms: readonly Form[],
): [string, string] {
  const module = via === "package" ? PACKAGE : relative(file, CLIENT);
  return [`${scope}/${file}`, `${forms.map((form) => FORMS[form](module)).join("\n")}\n`];
}

// What a feature's reported files import: `ports.ts` and `tables.ts` only type-only, and the others a
// mix. Together the five hold every form, and both ways of spelling a module.
const REPORTED_FILES: readonly (readonly [string, Via, readonly Form[]])[] = [
  ["ports.ts", "package", ["type"]],
  ["adapters/driving/http.ts", "path", ["static", "type"]],
  ["adapters/driven/jobs.ts", "package", ["reexport", "reexportType", "dynamic"]],
  ["adapters/driven/queue/nested.ts", "path", ["typeImport", "require"]],
  ["adapters/driven/tables.ts", "package", ["reexportType"]],
];

// Whether every import of a reported file is type-only, by the file's path below its feature.
export const TYPE_ONLY: Readonly<Record<string, boolean>> = {
  "ports.ts": true,
  "adapters/driving/http.ts": false,
  "adapters/driven/jobs.ts": false,
  "adapters/driven/queue/nested.ts": false,
  "adapters/driven/tables.ts": true,
};

function featureFiles(feature: string): Record<string, string> {
  const src = `src/${feature}`;
  const reported = REPORTED_FILES.map(([file, via, forms]) =>
    importing(SHOP, `${src}/${file}`, via, forms),
  );
  // Clean beside them: the core and the entry file, a test of an adapter, and a local effect the
  // technology list does not name.
  const clean = [
    importing(SHOP, `${src}/index.ts`, "package", ALL),
    importing(SHOP, `${src}/application/place.ts`, "path", ALL),
    [
      `${SHOP}/${src}/adapters/driven/git.ts`,
      'import { simpleGit } from "simple-git";\nimport { execFileSync } from "node:child_process";\nexport const git = [simpleGit, execFileSync];\n',
    ],
  ];
  return Object.fromEntries([...reported, ...clean]);
}

const SHOP_FILES: Record<string, string> = {
  ...Object.assign({}, ...FEATURES.map(featureFiles)),
  ...Object.fromEntries([
    importing(SHOP, "src/lib/queue-client.ts", "package", ALL),
    importing(SHOP, "src/orders/adapters/driven/queue.test.ts", "package", ALL),
    importing(SHOP, "src/shipping/ports.test.ts", "path", ALL),
    importing(SHOP, "src/interpreters/queue/index.ts", "package", ALL),
  ]),
};

// The port layout: the reported files are the port folders under `application/` and the adapter
// folders, and the use case beside them is clean.
const MAIL_REPORTED: readonly (readonly [string, Via, readonly Form[]])[] = [
  ["src/application/driving-ports/send.ts", "package", ["type", "static"]],
  ["src/application/driven-ports/mailbox.ts", "path", ["reexportType"]],
  ["src/driven-adapters/outbox.ts", "package", ["static", "dynamic", "require"]],
  ["src/driving-adapters/http.ts", "path", ["typeImport", "reexport"]],
];

const MAIL_FILES: Record<string, string> = Object.fromEntries([
  ...MAIL_REPORTED.map(([file, via, forms]) => importing(MAIL, file, via, forms)),
  importing(MAIL, "src/application/send-mail.ts", "package", ALL),
  importing(MAIL, "src/lib/queue-client.ts", "package", ALL),
  importing(MAIL, "src/interpreters/queue/index.ts", "package", ALL),
]);

export const INTERPRETER_FILES: Readonly<Record<string, string>> = {
  ...shopManifests([SHOP, MAIL]),
  ...SHOP_FILES,
  ...MAIL_FILES,
};

const QUEUE = { root: "src/interpreters/queue", modules: [PACKAGE, CLIENT] };

export const INTERPRETER_RULES_WITHOUT_INTERPRETERS = {
  features: {
    [SHOP]: [...FEATURES],
    [MAIL]: ["application", "driving-adapters", "driven-adapters"],
  },
  testFiles: ["**/*.test.ts"],
};

export const INTERPRETER_RULES = {
  ...INTERPRETER_RULES_WITHOUT_INTERPRETERS,
  interpreters: { [SHOP]: { queue: QUEUE }, [MAIL]: { queue: QUEUE } },
};

// `[scope, kind, from, to ?? specifier]` of the nineteen files a `--ci` run must list.
export const INTERPRETER_CROSSINGS: readonly (readonly [string, string, string, string])[] = [
  ...FEATURES.flatMap((feature) =>
    REPORTED_FILES.map(
      ([file]) =>
        [
          SHOP,
          "technology-outside-interpreter",
          `${SHOP}/src/${feature}/${file}`,
          "queue",
        ] as const,
    ),
  ),
  ...MAIL_REPORTED.map(
    ([file]) => [MAIL, "technology-outside-interpreter", `${MAIL}/${file}`, "queue"] as const,
  ),
];
