import { nameText } from "../extract/functions.js";
import type { SourceUnit } from "../extract/project.js";
import { field, nodeField, type SyntaxFile, type SyntaxNode } from "../syntax/file.js";

export type EnvReadVia = "env" | "process-env";
export type EnvRead = { name: string; file: string; line: number; via: EnvReadVia };

export type EnvKeyScan = {
  reads: EnvRead[];
  occursIn: Map<string, string[]>;
};

function receiverVia(syntax: SyntaxFile, expr: SyntaxNode): EnvReadVia | null {
  const text = syntax.textOf(expr);
  if (text === "process.env" || text.endsWith(".process.env")) return "process-env";
  if (text === "env" || /\.env$/.test(text)) return "env";
  return null;
}

function bindingElementNames(syntax: SyntaxFile, pattern: SyntaxNode | null): string[] {
  if (pattern?.type !== "ObjectPattern") return [];
  const names: string[] = [];
  for (const element of field(pattern, "properties") as SyntaxNode[]) {
    if (element.type === "RestElement") {
      const argument = nodeField(element, "argument");
      if (argument !== null) names.push(identifierText(syntax, argument));
      continue;
    }
    const key = nodeField(element, "key");
    if (key === null) continue;
    names.push(
      field(element, "shorthand") === true
        ? identifierText(syntax, key)
        : nameText(syntax, element, key),
    );
  }
  return names;
}

function identifierText(syntax: SyntaxFile, node: SyntaxNode): string {
  return node.type === "Identifier" ? String(field(node, "name")) : syntax.textOf(node);
}

type Push = (name: string, line: number, via: EnvReadVia) => void;

function visitMemberAccess(syntax: SyntaxFile, node: SyntaxNode, push: Push): void {
  if (node.type !== "MemberExpression") return;
  const object = nodeField(node, "object");
  const property = nodeField(node, "property");
  if (object === null || property === null) return;
  if (field(node, "computed") === true) {
    if (property.type !== "Literal" || typeof field(property, "value") !== "string") return;
    const via = receiverVia(syntax, object);
    if (via !== null) push(String(field(property, "value")), syntax.startLine(node), via);
    return;
  }
  const via = receiverVia(syntax, object);
  if (via !== null) push(propertyText(syntax, property), syntax.startLine(node), via);
}

function propertyText(syntax: SyntaxFile, property: SyntaxNode): string {
  if (property.type === "Identifier") return String(field(property, "name"));
  return syntax.textOf(property);
}

function visitDestructureFromEnv(syntax: SyntaxFile, node: SyntaxNode, push: Push): void {
  if (node.type !== "VariableDeclarator") return;
  const initializer = nodeField(node, "init");
  if (initializer === null) return;
  const via = receiverVia(syntax, initializer);
  if (via === null) return;
  for (const name of bindingElementNames(syntax, nodeField(node, "id"))) {
    push(name, syntax.startLine(node), via);
  }
}

// A parameter's binding pattern and type: `{ A }: Env`, or `{ A }: Env = fallback`.
function patternOfParameter(param: SyntaxNode): SyntaxNode | null {
  if (param.type === "ObjectPattern") return param;
  if (param.type !== "AssignmentPattern") return null;
  const left = nodeField(param, "left");
  return left?.type === "ObjectPattern" ? left : null;
}

function hasEnvTypeAnnotation(syntax: SyntaxFile, pattern: SyntaxNode): boolean {
  const annotation = nodeField(pattern, "typeAnnotation");
  const typeNode = annotation === null ? null : nodeField(annotation, "typeAnnotation");
  return typeNode !== null && /\bEnv\b/.test(syntax.textOf(typeNode));
}

function visitEnvTypedParameters(syntax: SyntaxFile, node: SyntaxNode, push: Push): void {
  const params = field(node, "params");
  if (!Array.isArray(params)) return;
  for (const param of params as SyntaxNode[]) {
    const pattern = patternOfParameter(param);
    if (pattern === null || !hasEnvTypeAnnotation(syntax, pattern)) continue;
    for (const name of bindingElementNames(syntax, pattern)) {
      push(name, syntax.startLine(param), "env");
    }
  }
}

function visitRead(syntax: SyntaxFile, node: SyntaxNode, push: Push): void {
  visitMemberAccess(syntax, node, push);
  visitDestructureFromEnv(syntax, node, push);
  visitEnvTypedParameters(syntax, node, push);
}

function occurrenceName(node: SyntaxNode, candidates: ReadonlySet<string>): string | null {
  let text: string | null = null;
  if (node.type === "Identifier" || node.type === "JSXIdentifier") {
    text = String(field(node, "name"));
  } else if (node.type === "PrivateIdentifier") {
    text = `#${String(field(node, "name"))}`;
  } else if (node.type === "Literal" && typeof field(node, "value") === "string") {
    text = String(field(node, "value"));
  }
  return text !== null && candidates.has(text) ? text : null;
}

export function scanEnvKeys(
  sourceFiles: readonly SourceUnit[],
  candidateNames: ReadonlySet<string>,
): EnvKeyScan {
  const reads = new Map<string, EnvRead>();
  const occursIn = new Map<string, Set<string>>();

  for (const { file, syntax } of sourceFiles) {
    const visit = (node: SyntaxNode): void => {
      visitRead(syntax, node, (name, line, via) => {
        const key = `${name}\t${file}\t${line}\t${via}`;
        if (!reads.has(key)) reads.set(key, { name, file, line, via });
      });
      const occ = occurrenceName(node, candidateNames);
      if (occ !== null) {
        const bucket = occursIn.get(occ);
        if (bucket === undefined) occursIn.set(occ, new Set([file]));
        else bucket.add(file);
      }
      for (const child of syntax.children(node)) visit(child);
    };
    for (const child of syntax.children(syntax.program)) visit(child);
  }

  const sortedReads = [...reads.values()].sort(
    (a, b) =>
      a.name.localeCompare(b.name) ||
      a.file.localeCompare(b.file) ||
      a.line - b.line ||
      a.via.localeCompare(b.via),
  );
  const sortedOccurs = new Map<string, string[]>();
  for (const [name, files] of [...occursIn].sort((a, b) => a[0].localeCompare(b[0]))) {
    sortedOccurs.set(
      name,
      [...files].sort((a, b) => a.localeCompare(b)),
    );
  }
  return { reads: sortedReads, occursIn: sortedOccurs };
}
