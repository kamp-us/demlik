import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import {
  emitDeclarations,
  emittedEntries,
  emittedFileOf,
  removeEmit,
} from "../../packages/code-graph/src/api/emit.js";
import { ApiInputError } from "../../packages/code-graph/src/api/map.js";
import { readSubpathNames } from "../../packages/code-graph/src/api/read.js";
import {
  declarationText,
  statementOf,
  tidyLines,
  withoutComments,
} from "../../packages/code-graph/src/api/text.js";
import {
  packageRoot,
  projectRelative,
  readEmittedNames,
  readPublishedApi,
} from "../../packages/code-graph/src/api/view.js";
import * as ts from "../../packages/code-graph/src/engine/tsgo.js";

const unknown = z
  .unknown()
  .refine((v) => v !== undefined, "required JSON value");
const scalar = z.union([
  z.number(),
  z.enum(["NaN", "Infinity", "-Infinity", "-0"]),
]);
const subpath = z.strictObject({
  subpath: z.string(),
  entry: z.string(),
  entryAbsolute: z.string(),
  tier: z.string().nullable(),
});
const emit = z.strictObject({
  temp: z.string(),
  out: z.string(),
  compiler: z.string(),
  diagnostics: scalar,
});
const warning = z.enum(["collect", "default", "fail"]);
const selectedKind = z.enum([
  "SourceFile",
  "VariableDeclaration",
  "FunctionDeclaration",
  "ClassDeclaration",
  "InterfaceDeclaration",
  "ModuleDeclaration",
]);
export const apiViewSchema = z.discriminatedUnion("action", [
  z.strictObject({ action: z.literal("text"), text: z.string() }),
  z.strictObject({
    action: z.literal("file"),
    emit,
    root: z.string(),
    entry: z.string(),
  }),
  z.strictObject({ action: z.literal("package"), root: z.string() }),
  z.strictObject({
    action: z.literal("remove"),
    temp: z.string(),
    watch: z.array(z.string()),
  }),
  z.strictObject({
    action: z.literal("read"),
    root: z.string(),
    map: unknown,
    repoRoot: z.string().nullable(),
    warn: warning,
  }),
  z.strictObject({
    action: z.literal("emitted"),
    root: z.string(),
    subpaths: z.array(subpath),
    repoRoot: z.string().nullable(),
    context: z.string().nullable(),
    warn: warning,
  }),
  z.strictObject({
    action: z.literal("emit"),
    root: z.string(),
    config: z.string(),
    subpaths: z.array(subpath),
  }),
  z.strictObject({
    action: z.literal("lookup-text"),
    config: z.string(),
    roots: z.array(z.string()),
    lookups: z.array(z.string()),
  }),
  z.strictObject({
    action: z.literal("program"),
    config: z.string(),
    out: z.string(),
    entries: z.array(z.tuple([z.string(), z.string()])),
  }),
  z.strictObject({
    action: z.literal("nodes"),
    config: z.string(),
    file: z.string(),
    select: z.array(
      z.strictObject({
        kind: selectedKind,
        nth: z.number().int().nonnegative(),
      }),
    ),
  }),
]);
export type ApiViewInput = z.infer<typeof apiViewSchema>;
const normalize = (value: unknown): unknown =>
  JSON.parse(JSON.stringify(value));
const inventory = () =>
  fs
    .readdirSync(os.tmpdir())
    .filter((f) => f.startsWith("code-graph-api-"))
    .sort();
function thrown(error: unknown) {
  if (!(error instanceof Error)) throw error;
  return { name: error.name, message: error.message };
}
function rows(names: ReturnType<typeof readSubpathNames>) {
  const prototype = Object.getPrototypeOf(names);
  const values = Object.values(names);
  return {
    names,
    keys: Object.keys(names),
    prototype: prototype === Object.prototype ? null : prototype,
    identity: values.map((left) => values.map((right) => left === right)),
  };
}
export async function apiViewReference(input: ApiViewInput): Promise<unknown> {
  switch (input.action) {
    case "text":
      return {
        clean: withoutComments(input.text),
        tidy: tidyLines(input.text),
        declaration: tidyLines(withoutComments(input.text)),
      };
    case "file":
      return {
        file: emittedFileOf(
          { ...input.emit, diagnostics: 0 },
          input.root,
          input.entry,
        ),
      };
    case "package":
      try {
        const root = packageRoot(input.root);
        return { root, relative: projectRelative(root) };
      } catch (error) {
        return { thrown: thrown(error) };
      }
    case "remove": {
      try {
        removeEmit({ temp: input.temp });
        return {
          exists: fs.existsSync(input.temp),
          watched: input.watch.map((p) => fs.existsSync(p)),
        };
      } catch (error) {
        return {
          thrown: thrown(error),
          watched: input.watch.map((p) => fs.existsSync(p)),
        };
      }
    }
    case "read":
    case "emitted": {
      const before = inventory(),
        warnings: string[] = [];
      const warn =
        input.warn === "default"
          ? undefined
          : (line: string) => {
              warnings.push(line);
              if (input.warn === "fail")
                throw new ApiInputError("warning callback \ud800 failed", {
                  cause: new Error("callback cause retained"),
                });
            };
      let value: object;
      try {
        const options = { repoRoot: input.repoRoot ?? undefined, warn };
        if (input.action === "read") {
          const view = await readPublishedApi(input.root, input.map, options);
          value = {
            view,
            prototypes: Object.entries(view.subpaths).map(([name, part]) => {
              const prototype = Object.getPrototypeOf(part.names);
              return [name, prototype === Object.prototype ? null : prototype];
            }),
          };
        } else {
          const emitted = await readEmittedNames(input.root, input.subpaths, {
            ...options,
            context: input.context ?? undefined,
          });
          value = {
            compiler: emitted.compiler,
            names: [...emitted.names].map(([key, names]) => [key, rows(names)]),
          };
        }
      } catch (error) {
        value = { thrown: thrown(error) };
      }
      return normalize({
        ...value,
        warnings,
        tempClean: JSON.stringify(before) === JSON.stringify(inventory()),
      });
    }
    case "emit": {
      const before = inventory();
      let value: object;
      try {
        const emit = await emitDeclarations(input.root, input.config);
        try {
          const entries = emittedEntries(emit, input.root, input.subpaths);
          const installed = path.join(emit.temp, "node_modules");
          value = {
            compiler: emit.compiler,
            diagnostics: emit.diagnostics,
            files: [...entries].map(([key, file]) => [
              key,
              path.relative(emit.out, file).split(path.sep).join("/"),
            ]),
            text: [...entries].map(([key, file]) => [
              key,
              fs.readFileSync(file, "utf8"),
            ]),
            dependencyLink: fs.existsSync(installed)
              ? fs.readlinkSync(installed)
              : null,
            outsideRoot: !emit.temp.startsWith(`${input.root}${path.sep}`),
          };
        } finally {
          removeEmit(emit);
        }
      } catch (error) {
        value = { thrown: thrown(error) };
      }
      return normalize({
        ...value,
        tempClean: JSON.stringify(before) === JSON.stringify(inventory()),
      });
    }
    case "lookup-text": {
      const program = ts.openTypeProgram({
        tsConfigPath: input.config,
        rootFiles: input.roots,
        includeConfigFiles: false,
      });
      try {
        return input.lookups.map((file) => {
          try {
            const source = program.sourceFile(file);
            return source === undefined
              ? { file, found: false }
              : { file, found: true, fileName: source.fileName };
          } catch (error) {
            return { file, thrown: thrown(error) };
          }
        });
      } finally {
        program.close();
      }
    }
    case "program":
    case "nodes": {
      const roots =
        input.action === "program"
          ? [...new Set(input.entries.map(([, file]) => file))]
          : [input.file];
      const program = ts.openTypeProgram({
        tsConfigPath: input.config,
        rootFiles: roots.sort(),
        includeConfigFiles: false,
      });
      try {
        if (input.action === "program")
          return normalize(
            input.entries.map(([key, file]) => [
              key,
              rows(readSubpathNames(program, input.out, file)),
            ]),
          );
        const source = program.sourceFile(input.file);
        if (source === undefined) throw new Error("source file missing");
        const all: ts.Node[] = [];
        const visit = (node: ts.Node): undefined => {
          all.push(node);
          node.forEachChild(visit);
          return undefined;
        };
        visit(source);
        return input.select.map((select) => {
          const node = all.filter(
            (node) => ts.SyntaxKind[node.kind] === select.kind,
          )[select.nth];
          if (node === undefined) throw new Error("selected node missing");
          const statement = statementOf(node);
          return {
            kind: select.kind,
            statementKind: ts.SyntaxKind[statement.kind],
            text: declarationText(statement),
          };
        });
      } catch (error) {
        return { thrown: thrown(error) };
      } finally {
        program.close();
      }
    }
  }
}
if (process.argv[2] === "--single") {
  const input = apiViewSchema.parse(JSON.parse(process.argv[3]));
  process.stdout.write(`${JSON.stringify(await apiViewReference(input))}\n`);
}

export const COMMENT_PROBES: readonly string[] = [
  "export interface Shape {\n/** docs */\n readonly /* a */ p: P; // tail\n}",
  "const r = /https?://*x/; // gone",
  "const r = /a/*b/; // gone",
  "const r = /[/*]/; // gone",
  "const r = /[//]/; // gone",
  'const x = "/* keep */"; // gone',
  "const x = `// keep`; /* gone */",
  'export type T = `a\u0024{{b: 1}["b"]}/*keep*/`; // gone',
  'export type T = `a\u0024{`b\u0024{"/*keep*/"}`}z`; /* gone */',
  "bad ??? /* c */ stuff // a\nmore /* b */",
  "export type T = ; /* last */",
  '"unfinished // kept\n/* gone */ tail',
  "`unfinished // kept\n/* kept */ tail",
  'export declare const x: "\ud800/*keep*/"; /* gone */',
  "\ud800 // gone\n type T = string; /* tail */",
  "/*!unterminated",
  "<<< broken // gone\n trailing /* rest */",
  "const x = <T>(n:T) => n; // gone",
  'interface T { readonly a: "\\"//keep"; } /* gone */',
  "//a\u2028//b\u2029//c\r//d\nlast",
  "const x = 1; <!-- html\nconst z = 2; --> html\n",
  "#! /bin/node\n// gone\nexport {};",
];
