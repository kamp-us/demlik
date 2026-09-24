import { Node, type SourceFile } from "ts-morph";
import { toRelative } from "../extract/project.js";

export type EnvReadVia = "env" | "process-env";
export type EnvRead = { name: string; file: string; line: number; via: EnvReadVia };

export type EnvKeyScan = {
  reads: EnvRead[];
  occursIn: Map<string, string[]>;
};

function receiverVia(expr: Node): EnvReadVia | null {
  const text = expr.getText();
  if (text === "process.env" || text.endsWith(".process.env")) return "process-env";
  if (text === "env" || /\.env$/.test(text)) return "env";
  return null;
}

function bindingElementNames(pattern: Node): string[] {
  if (!Node.isObjectBindingPattern(pattern)) return [];
  const names: string[] = [];
  for (const el of pattern.getElements()) {
    if (Node.isBindingElement(el)) {
      const propertyName = el.getPropertyNameNode();
      names.push(propertyName !== undefined ? propertyName.getText() : el.getName());
    }
  }
  return names;
}

function hasEnvTypeAnnotation(param: Node): boolean {
  if (!Node.isParameterDeclaration(param)) return false;
  const typeNode = param.getTypeNode();
  return typeNode !== undefined && /\bEnv\b/.test(typeNode.getText());
}

type Push = (name: string, line: number, via: EnvReadVia) => void;

function visitPropertyAccess(node: Node, push: Push): void {
  if (!Node.isPropertyAccessExpression(node)) return;
  const via = receiverVia(node.getExpression());
  if (via !== null) push(node.getName(), node.getStartLineNumber(), via);
}

function visitElementAccess(node: Node, push: Push): void {
  if (!Node.isElementAccessExpression(node)) return;
  const arg = node.getArgumentExpression();
  if (arg === undefined || !Node.isStringLiteral(arg)) return;
  const via = receiverVia(node.getExpression());
  if (via !== null) push(arg.getLiteralValue(), node.getStartLineNumber(), via);
}

function visitDestructureFromEnv(node: Node, push: Push): void {
  if (!Node.isVariableDeclaration(node)) return;
  const initializer = node.getInitializer();
  if (initializer === undefined) return;
  const via = receiverVia(initializer);
  if (via === null) return;
  for (const name of bindingElementNames(node.getNameNode())) {
    push(name, node.getStartLineNumber(), via);
  }
}

function visitEnvTypedParameter(node: Node, push: Push): void {
  if (!Node.isParameterDeclaration(node) || !hasEnvTypeAnnotation(node)) return;
  for (const name of bindingElementNames(node.getNameNode())) {
    push(name, node.getStartLineNumber(), "env");
  }
}

function visitRead(node: Node, push: Push): void {
  visitPropertyAccess(node, push);
  visitElementAccess(node, push);
  visitDestructureFromEnv(node, push);
  visitEnvTypedParameter(node, push);
}

function occurrenceName(node: Node, candidates: ReadonlySet<string>): string | null {
  if (!Node.isIdentifier(node) && !Node.isStringLiteral(node) && !Node.isPrivateIdentifier(node)) {
    return null;
  }
  const text = Node.isStringLiteral(node) ? node.getLiteralValue() : node.getText();
  return candidates.has(text) ? text : null;
}

export function scanEnvKeys(
  sourceFiles: readonly SourceFile[],
  rootAbsolute: string,
  candidateNames: ReadonlySet<string>,
): EnvKeyScan {
  const reads = new Map<string, EnvRead>();
  const occursIn = new Map<string, Set<string>>();

  for (const sf of sourceFiles) {
    const file = toRelative(rootAbsolute, sf.getFilePath());
    sf.forEachDescendant((node) => {
      visitRead(node, (name, line, via) => {
        const key = `${name}\t${file}\t${line}\t${via}`;
        if (!reads.has(key)) reads.set(key, { name, file, line, via });
      });
      const occ = occurrenceName(node, candidateNames);
      if (occ !== null) {
        const bucket = occursIn.get(occ);
        if (bucket === undefined) occursIn.set(occ, new Set([file]));
        else bucket.add(file);
      }
    });
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
