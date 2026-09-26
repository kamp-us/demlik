import path from "node:path";
import { type Comment, type Node, type Program, parseSync, visitorKeys } from "oxc-parser";
import { ResolverFactory } from "oxc-resolver";

// The one directory that imports oxc: the parser every syntax pass reads, and the resolver the
// import graph resolves specifiers with.
export type { Comment, Node, Program };

export type ParsedModule =
  | { readonly ok: true; readonly program: Program; readonly comments: readonly Comment[] }
  | { readonly ok: false };

export function parseTypeScript(fileName: string, text: string): ParsedModule {
  const lang = fileName.endsWith(".tsx") ? "tsx" : "ts";
  const result = parseSync(fileName, text, { lang, sourceType: "module", preserveParens: true });
  if (result.errors.length > 0) return { ok: false };
  return { ok: true, program: result.program, comments: result.comments };
}

// A comment body read as code: parsed as TSX, and `null` when the parser reports any error.
export function parseSnippet(text: string): Program | null {
  const result = parseSync("snippet.tsx", text, {
    lang: "tsx",
    sourceType: "module",
    preserveParens: true,
  });
  return result.errors.length > 0 ? null : result.program;
}

export function childKeysOf(node: Node): readonly string[] {
  return visitorKeys[node.type] ?? [];
}

export type ModuleResolver = (fromFile: string, specifier: string) => string | null;

export function createModuleResolver(tsConfigPath: string): ModuleResolver {
  const factory = new ResolverFactory({
    tsconfig: { configFile: tsConfigPath },
    extensions: [".ts", ".tsx", ".d.ts", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs", ".json"],
    extensionAlias: {
      ".js": [".ts", ".tsx", ".d.ts", ".js"],
      ".jsx": [".tsx", ".jsx"],
      ".mjs": [".mts", ".mjs"],
      ".cjs": [".cts", ".cjs"],
    },
    conditionNames: ["types", "import", "node", "default"],
  });
  return (fromFile, specifier) => factory.sync(path.dirname(fromFile), specifier).path ?? null;
}
