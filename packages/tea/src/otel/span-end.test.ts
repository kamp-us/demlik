/**
 * `endSpan` is the only place `./otel` calls `Span#end` (#373).
 *
 * `endSpan` is where a span's end goes through `spanTime`, the one conversion
 * from the run's clock to OpenTelemetry time (#367). A bare `span.end()`
 * anywhere else is stamped with the SDK's wall clock instead, which is how a
 * detached span once ended on a different timeline from its start. Nothing in
 * the types refuses that call, so this reads the module with the type checker
 * and fails on any `end` call whose receiver is an OpenTelemetry `Span`
 * outside `endSpan`. A receiver of any other type — `spans.end()` on
 * `AgentSpans` — is not a `Span#end` and does not count.
 */

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const MODULE = join(dirname(fileURLToPath(import.meta.url)), "index.ts");
const PKG_ROOT = join(dirname(MODULE), "..", "..");

const config = ts.parseJsonConfigFileContent(
  ts.readConfigFile(join(PKG_ROOT, "tsconfig.json"), ts.sys.readFile).config,
  ts.sys,
  PKG_ROOT,
);
const program = ts.createProgram([MODULE], {
  ...config.options,
  noEmit: true,
});
const checker = program.getTypeChecker();

// Is `type` OpenTelemetry's `Span`, as declared by `@opentelemetry/api`?
function isOtelSpan(type: ts.Type): boolean {
  const symbol = type.aliasSymbol ?? type.getSymbol();
  return (
    symbol?.getName() === "Span" &&
    (symbol.declarations ?? []).some((d) =>
      d.getSourceFile().fileName.includes("@opentelemetry/api"),
    )
  );
}

// The name of the function declaration a node sits in, or `<module>`.
function enclosingFunction(node: ts.Node): string {
  for (let at = node.parent; at !== undefined; at = at.parent) {
    if (ts.isFunctionDeclaration(at)) return at.name?.text ?? "<anonymous>";
    if (
      (ts.isArrowFunction(at) || ts.isFunctionExpression(at)) &&
      ts.isVariableDeclaration(at.parent) &&
      ts.isIdentifier(at.parent.name)
    ) {
      return at.parent.name.text;
    }
  }
  return "<module>";
}

function spanEndCallSites(): readonly string[] {
  const source = program.getSourceFile(MODULE);
  if (source === undefined) throw new Error(`could not read ${MODULE}`);
  const sites: string[] = [];
  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === "end" &&
      isOtelSpan(checker.getTypeAtLocation(node.expression.expression))
    ) {
      const { line } = source.getLineAndCharacterOfPosition(node.getStart());
      sites.push(`${enclosingFunction(node)} (index.ts:${line + 1})`);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return sites;
}

describe("./otel — every span ends through endSpan", () => {
  it("calls Span#end in endSpan and nowhere else", () => {
    // Exactly one hit, and it is endSpan's: the scan sees a real call site,
    // so an empty answer can never pass for a clean one. A failure lists
    // every site it found.
    expect(spanEndCallSites()).toEqual([expect.stringMatching(/^endSpan /)]);
  });
});
