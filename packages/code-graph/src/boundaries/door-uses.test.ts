import { describe, expect, it } from "vitest";
import { sourceUnit } from "../test-helpers/source-unit.js";
import { type DoorUse, detectDoorUses } from "./door-uses.js";
import {
  DOOR_ROWS,
  DOORS,
  type DoorName,
  type DoorRowName,
  declaredDoorOf,
  moduleDoorOf,
  moduleDoorsOpened,
  pathDoorOf,
} from "./doors.js";

const usesOf = (source: string): DoorUse[] => detectDoorUses(sourceUnit(source).syntax);
const doorsOf = (source: string): DoorName[] => [...new Set(usesOf(source).map((u) => u.door))];

// One case per catalog row. `satisfies Record<DoorRowName, …>` makes a new row in `DOORS` fail to
// compile until it has a case here, and the shape check below keeps a case honest about how its
// door is read: from the syntax tree, from an import edge, or, for a family row, from the syntax
// tree with each use naming the member door it falls under.
type DoorCase =
  | { readonly via: "syntax"; readonly uses: readonly string[]; readonly pure: readonly string[] }
  | {
      readonly via: "members";
      // Every door a source reads: `globalThis.process.platform` is a use of `globalThis` too.
      readonly uses: Readonly<Record<string, readonly string[]>>;
      readonly pure: readonly string[];
    }
  | { readonly via: "edge"; readonly uses: readonly string[]; readonly pure: readonly string[] };

const CASES = {
  "process.<member>": {
    via: "members",
    uses: {
      "process.env.X;": ["process.env"],
      'process.env["X"];': ["process.env"],
      "process.env[k];": ["process.env"],
      'process["env"].X;': ["process.env"],
      "const { X } = process.env;": ["process.env"],
      "const { env } = process;": ["process.env"],
      "const all = { ...process.env };": ["process.env"],
      "load(process.env);": ["process.env"],
      "const { X = 1, Y: renamed, ...rest } = process.env;": ["process.env"],
      "process?.env?.X;": ["process.env"],
      "(process as NodeJS.Process).env;": ["process.env"],
      "process.env!.X;": ["process.env"],
      ["`" + "$" + "{process.env.X}`;"]: ["process.env"],
      "process.argv.slice(2);": ["process.argv"],
      "const [, , first] = process.argv;": ["process.argv"],
      "process.stdin.isTTY;": ["process.stdin"],
      "process.stdin.on('data', f);": ["process.stdin"],
      "const { stdin } = process;": ["process.stdin"],
      "process.stdout.write('x');": ["process.stdout"],
      "const { stdout: { isTTY } } = process;": ["process.stdout"],
      "process.stderr.write('x');": ["process.stderr"],
      "process.exit(1);": ["process.exit"],
      "run(process.exit);": ["process.exit"],
      "process.cwd();": ["process.cwd"],
      "const { cwd } = process;": ["process.cwd"],
      "process.hrtime();": ["process.hrtime"],
      'process["hrtime"]();': ["process.hrtime"],
      "process.hrtime.bigint();": ["process.hrtime"],
      "const { hrtime } = process;": ["process.hrtime"],
      "const { memoryUsage: mem } = process;": ["process.memoryUsage"],
      "process.platform;": ["process.platform"],
      "globalThis.process.platform;": ["globalThis", "process.platform"],
      'process?.on?.("exit", f);': ["process.on"],
      "process.versions.node;": ["process.versions"],
      "const { arch } = process;": ["process.arch"],
      "process.uptime();": ["process.uptime"],
    },
    pure: [
      "const p = process;",
      "type Env = typeof process.env;",
      "type P = typeof process.platform;",
      "let p: typeof process.hrtime;",
      "process;",
      "process[k];",
      "const { ...rest } = process;",
      "const { [k]: v } = process;",
      "const argv = [];",
      "stdin.isTTY;",
      "exit(1);",
      "o.process.hrtime();",
      "const process = inject(); process.platform;",
      "function run(process: P) { return process.hrtime(); }",
      "import process from './world.js'; process.platform;",
    ],
  },
  "Date.now": {
    via: "syntax",
    uses: ["Date.now();", "const now = Date.now;", "const { now } = Date;", "Date['now']();"],
    pure: ["Date.parse('x');", "Date.UTC(2020, 1);", "type D = Date;", "const d: Date = x;"],
  },
  "Math.random": {
    via: "syntax",
    uses: ["Math.random();", "const { random } = Math;"],
    pure: ["Math.floor(n);", "Math.max(1, 2);"],
  },
  "crypto.randomUUID": {
    via: "syntax",
    uses: ["crypto.randomUUID();", "const { randomUUID } = crypto;"],
    pure: ["crypto.subtle;"],
  },
  "crypto.getRandomValues": {
    via: "syntax",
    uses: ["crypto.getRandomValues(new Uint8Array(4));", "const { getRandomValues } = crypto;"],
    pure: ["crypto;"],
  },
  "performance.now": {
    via: "syntax",
    uses: ["performance.now();", "const { now } = performance;"],
    pure: ["performance.mark('a');"],
  },
  fetch: {
    via: "syntax",
    uses: ["fetch('u');", "const f = fetch;", "run(fetch);", "typeof fetch;", "fetch?.('u');"],
    pure: [
      "const o = { fetch: 1 };",
      "o.fetch('u');",
      "this.fetch('u');",
      "class A { fetch() {} }",
    ],
  },
  setTimeout: {
    via: "syntax",
    uses: ["setTimeout(f, 1);", "const t = setTimeout;"],
    pure: ["o.setTimeout(f, 1);", "const o = { setTimeout: 1 };"],
  },
  setInterval: {
    via: "syntax",
    uses: ["setInterval(f, 1);", "const t = setInterval;"],
    pure: ["o.setInterval(f, 1);"],
  },
  globalThis: {
    via: "syntax",
    uses: ["globalThis;", "globalThis.x = 1;", "globalThis['x'];", "run(globalThis);"],
    pure: ["type G = typeof globalThis;"],
  },
  console: {
    via: "syntax",
    uses: ["console.log('x');", "console.error('x');", "const { log } = console;", "run(console);"],
    pure: [
      "o.console.log('x');",
      "const o = { console: 1 };",
      "console: for (;;) { break console; }",
    ],
  },
  "new Date()": {
    via: "syntax",
    uses: ["new Date();", "new Date;", "const now = new Date();"],
    pure: [
      "new Date(0);",
      "new Date(x);",
      "new Date(...args);",
      "new Date('2020-01-01');",
      "Date();",
    ],
  },
  "node:fs": {
    via: "edge",
    uses: ["node:fs", "fs", "node:fs/promises", "fs/promises"],
    pure: ["fs-extra", "node:fsx", "./fs.js", "@acme/fs"],
  },
  "node:child_process": {
    via: "edge",
    uses: ["node:child_process", "child_process", "node:child_process/foo"],
    pure: ["child_process_x", "execa"],
  },
} as const satisfies Record<DoorRowName, DoorCase>;

const edge = (specifier: string, over: { target?: string | null; typeOnly?: boolean } = {}) => ({
  specifier,
  target: over.target ?? null,
  typeOnly: over.typeOnly ?? false,
});

const VIA = { path: "syntax", "bare-new": "syntax", members: "members", module: "edge" } as const;

describe("the door catalog is one table that every consumer reads", () => {
  it("has a case for every row, and each case reads its door the way the table says", () => {
    expect(Object.keys(CASES).sort()).toEqual([...DOOR_ROWS].sort());
    for (const name of DOOR_ROWS) {
      expect(CASES[name].via, name).toBe(VIA[DOORS[name].shape]);
    }
  });

  it("holds one row for `process.<member>`, not a row per member", () => {
    expect(DOOR_ROWS.filter((name) => name.startsWith("process."))).toEqual(["process.<member>"]);
  });

  it("holds no row whose prefix is a prefix of another's, so a use falls under exactly one", () => {
    const prefixes = DOOR_ROWS.flatMap((name) => {
      const row = DOORS[name];
      if (row.shape === "path") return [name.split(".")];
      return row.shape === "members" ? [[row.of]] : [];
    });
    for (const a of prefixes) {
      for (const b of prefixes) {
        if (a === b) continue;
        const prefix = a.length <= b.length && a.every((segment, i) => b[i] === segment);
        expect(prefix, `${a.join(".")} / ${b.join(".")}`).toBe(false);
      }
    }
  });

  for (const name of DOOR_ROWS) {
    const row = CASES[name];
    it(`reads ${name} and only ${name}`, () => {
      switch (row.via) {
        case "syntax":
          for (const source of row.uses) expect(doorsOf(source), source).toEqual([name]);
          for (const source of row.pure) expect(doorsOf(source), source).toEqual([]);
          return;
        case "members":
          for (const [source, doors] of Object.entries(row.uses)) {
            expect(doorsOf(source).sort(), source).toEqual([...doors].sort());
          }
          for (const source of row.pure) expect(doorsOf(source), source).toEqual([]);
          return;
        case "edge":
          for (const specifier of row.uses) {
            expect(moduleDoorOf(edge(specifier)), specifier).toBe(name);
          }
          for (const specifier of row.pure) {
            expect(moduleDoorOf(edge(specifier)), specifier).toBeNull();
          }
          return;
        default: {
          const exhaustive: never = row;
          return exhaustive;
        }
      }
    });
  }
});

describe("every member of process is a door, named by the member", () => {
  it("keeps the seven names the catalog once listed row by row, so an old ledger gates unchanged", () => {
    for (const member of ["env", "argv", "stdin", "stdout", "stderr", "exit", "cwd"]) {
      expect(doorsOf(`process.${member};`), member).toEqual([`process.${member}`]);
    }
  });

  it("is one door per member however deep the read goes, and two for two members", () => {
    expect(doorsOf("process.hrtime(); process.hrtime.bigint();")).toEqual(["process.hrtime"]);
    expect(
      usesOf("process.hrtime(); process.hrtime.bigint();").map((u) => u.path.join(".")),
    ).toEqual(["process.hrtime", "process.hrtime.bigint"]);
    expect(doorsOf("process.hrtime(); process.platform;").sort()).toEqual([
      "process.hrtime",
      "process.platform",
    ]);
  });

  it("names a member only when the file does: a bare `process` or `process[k]` is no door", () => {
    expect(pathDoorOf(["process"])).toBeNull();
    expect(pathDoorOf(["process", "hrtime", "bigint"])).toBe("process.hrtime");
    expect(doorsOf("run(process); const p = process; process[k]();")).toEqual([]);
  });
});

describe("what process.env is", () => {
  it("is one door however it is spelled, and `globalThis.process.env.CI` is also a use of globalThis", () => {
    expect(doorsOf("globalThis.process.env.CI;").sort()).toEqual(["globalThis", "process.env"]);
    expect(doorsOf("globalThis.fetch('u');").sort()).toEqual(["fetch", "globalThis"]);
    expect(doorsOf("globalThis.globalThis.Math.random();").sort()).toEqual([
      "Math.random",
      "globalThis",
    ]);
  });

  it("keeps the static path it read, up to the first step it cannot read", () => {
    const paths = (source: string) => usesOf(source).map((u) => u.path.join("."));
    expect(paths("process.stdin.isTTY;")).toEqual(["process.stdin.isTTY"]);
    expect(paths("process.env[k].x;")).toEqual(["process.env"]);
    expect(paths('process["env"].X;')).toEqual(["process.env.X"]);
    expect(paths("const { stdin: { isTTY } } = process;").sort()).toEqual([
      "process.stdin",
      "process.stdin.isTTY",
    ]);
  });

  it("still reads the expressions it could not follow", () => {
    expect(doorsOf("a[process.env.K].b[Math.random()];").sort()).toEqual([
      "Math.random",
      "process.env",
    ]);
    expect(doorsOf("const { [process.argv[0]]: x } = o;")).toEqual(["process.argv"]);
  });

  it("is not what scanEnvKeys calls an env receiver: only the real, unbound `process.env` counts", () => {
    expect(doorsOf("c.env.X; const { X } = env; env.Y; ctx.process.env.Z;")).toEqual([]);
    expect(doorsOf("const { X }: Env = e;")).toEqual([]);
  });
});

describe("a name the file binds itself is not the global", () => {
  const ROOTS = ["process", "fetch", "console", "Date", "Math", "crypto", "globalThis"] as const;
  const USE: Record<(typeof ROOTS)[number], string> = {
    process: "process.env.X;",
    fetch: "fetch('u');",
    console: "console.log('x');",
    Date: "Date.now();",
    Math: "Math.random();",
    crypto: "crypto.randomUUID();",
    globalThis: "globalThis.process.env.X;",
  };

  for (const root of ROOTS) {
    const binders = [
      `const ${root} = inject();`,
      `let ${root}: Thing;`,
      `function run(${root}: Thing) {}`,
      `const run = (${root}: Thing) => {};`,
      `const run = ({ ${root} }: Deps) => {};`,
      `const run = ([${root}]: Deps) => {};`,
      `import { ${root} } from "./world.js";`,
      `import ${root} from "./world.js";`,
      `import * as ${root} from "./world.js";`,
      `import { world as ${root} } from "./world.js";`,
      `function ${root}() {}`,
      `class ${root} {}`,
      `try {} catch (${root}) {}`,
      `for (const ${root} of xs) {}`,
      `const run = function ${root}() {};`,
    ];
    it(`${root}: an injected or imported ${root} is the pure pattern`, () => {
      for (const binder of binders) expect(doorsOf(`${binder}\n${USE[root]}`), binder).toEqual([]);
    });
    it(`${root}: a bare \`declare\` types the real global and does not shadow it`, () => {
      expect(doorsOf(`declare const ${root}: Thing;\n${USE[root]}`).length).toBeGreaterThan(0);
    });
  }

  it("fails open on a file that rebinds a name in one function and uses the real one in another", () => {
    expect(doorsOf("const f = (fetch: F) => fetch('u');\nconst g = () => fetch('v');")).toEqual([]);
  });
});

describe("what is not a use of a door", () => {
  it("a type position reads nothing at run time", () => {
    const types = [
      "type Env = typeof process.env;",
      "let e: typeof process.env;",
      "interface I { env: typeof process.env; at: Date }",
      "function f(): ReturnType<typeof fetch> { return g(); }",
      "const x = y as typeof process.env;",
      "class A implements B<typeof console> {}",
      "let t: typeof globalThis;",
    ];
    for (const source of types) expect(doorsOf(source), source).toEqual([]);
  });

  it("an assertion's operand is still read", () => {
    expect(doorsOf("const x = process.env as Env;")).toEqual(["process.env"]);
    expect(doorsOf("const x = <Env>process.env;")).toEqual(["process.env"]);
    expect(doorsOf("const x = (process.env satisfies Env);")).toEqual(["process.env"]);
  });

  it("a property, method, label or export name is a name and not a read", () => {
    const names = [
      "const o = { fetch: 1, console: 2, Date: 3 };",
      "const o = { async fetch() {} };",
      "export default { async fetch(req: Request) { return req; } };",
      "class A { fetch() {} static console = 1; get setTimeout() { return 1; } }",
      "o.fetch; o.process.env; o?.Date.now;",
      "import.meta.env.X;",
      "export { local as fetch };",
    ];
    for (const source of names) expect(doorsOf(source), source).toEqual([]);
  });

  it("a computed key is an expression and is read", () => {
    expect(doorsOf("const o = { [Date.now()]: 1 };")).toEqual(["Date.now"]);
    expect(doorsOf("class A { [Math.random()]() {} }")).toEqual(["Math.random"]);
  });

  it("follows no data flow: an alias or a require is not tracked", () => {
    expect(doorsOf("const p = process; p.env.X;")).toEqual([]);
    expect(doorsOf("import process from 'node:process'; process.env.X;")).toEqual([]);
    expect(doorsOf("const { env } = require('node:process'); env.X;")).toEqual([]);
  });

  it("reads code inside a namespace, a parameter default and a template", () => {
    expect(doorsOf("namespace N { export const t = Date.now(); }")).toEqual(["Date.now"]);
    expect(doorsOf("const f = ({ X } = process.env) => X;")).toEqual(["process.env"]);
    expect(doorsOf("class A { constructor(private t = Math.random()) {} }")).toEqual([
      "Math.random",
    ]);
  });

  it("reads a destructuring assignment, and not a rest element or a computed key", () => {
    expect(doorsOf("let x; ({ X: x } = process.env);")).toEqual(["process.env"]);
    expect(usesOf("const { ...rest } = process;")).toEqual([]);
    expect(usesOf("const { [k]: v } = process;")).toEqual([]);
  });
});

describe("a module door is an import edge that opens something", () => {
  it("a type-only import, or one that resolves to a file of the scope, opens nothing", () => {
    expect(moduleDoorOf(edge("node:fs", { typeOnly: true }))).toBeNull();
    expect(moduleDoorOf(edge("fs", { target: "src/fs.ts" }))).toBeNull();
    expect(moduleDoorOf(edge("node:fs"))).toBe("node:fs");
  });

  it("opens only what a runtime import names, because one edge stands for every literal of a specifier", () => {
    const edges = [
      edge("node:fs"),
      edge("node:child_process"),
      edge("fs", { target: "src/fs.ts" }),
    ];
    expect(moduleDoorsOpened(edges, new Set())).toEqual([]);
    expect(moduleDoorsOpened(edges, new Set(["node:fs", "fs"]))).toEqual(["node:fs"]);
  });
});

describe("a use belongs to the most specific declared door that is a path prefix of it", () => {
  const stdin = ["process", "stdin", "isTTY"];

  it("picks the deepest declaration, and none when nothing declared is a prefix", () => {
    expect(declaredDoorOf(stdin, ["process.stdin", "process.stdin.isTTY"])).toBe(
      "process.stdin.isTTY",
    );
    expect(declaredDoorOf(stdin, ["process.stdin"])).toBe("process.stdin");
    expect(declaredDoorOf(["process", "stdin", "on"], ["process.stdin.isTTY"])).toBeNull();
    expect(declaredDoorOf(["process", "stdinX"], ["process.stdin"])).toBeNull();
    expect(declaredDoorOf(["node:fs"], ["node:fs"])).toBe("node:fs");
    expect(declaredDoorOf(["new Date()"], ["new Date()"])).toBe("new Date()");
  });

  it("falls under the catalog door whose path is its prefix", () => {
    expect(pathDoorOf(stdin)).toBe("process.stdin");
    expect(pathDoorOf(["process", "platform"])).toBe("process.platform");
    expect(pathDoorOf(["Date"])).toBeNull();
  });
});
