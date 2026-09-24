import path from "node:path";
import { Node } from "ts-morph";
import type { CrossRuntimeEdge } from "../schema.js";
import type { BindingCatalog, BindingDecl, ServiceManifest } from "./wrangler-config.js";

export function unresolvedCalleeId(edge: {
  targetService: string;
  targetClass: string;
  method: string;
}): string {
  return `unresolved:${edge.targetService}.${edge.targetClass}.${edge.method}`;
}

function methodKey(dir: string, className: string, method: string): string {
  return `${dir}|${className}|${method}`;
}

function enclosingClassName(node: Node): string | null {
  const parent = node.getParent();
  if (parent === undefined) return null;
  if (Node.isClassDeclaration(parent)) return parent.getName() ?? "default";
  if (Node.isClassExpression(parent)) {
    const name = parent.getName();
    if (name !== undefined) return name;
    const owner = parent.getParent();
    if (owner !== undefined && Node.isVariableDeclaration(owner)) return owner.getName();
  }
  return null;
}

function bindingCallShape(callExpr: Node): { binding: string; method: string } | null {
  if (!Node.isCallExpression(callExpr)) return null;
  const method = callExpr.getExpression();
  if (!Node.isPropertyAccessExpression(method)) return null;
  const receiver = method.getExpression();
  if (!Node.isPropertyAccessExpression(receiver)) return null;
  return { binding: receiver.getName(), method: method.getName() };
}

export function ownerOf(
  manifests: ServiceManifest[],
  repoRelativeFile: string,
): ServiceManifest | null {
  let best: ServiceManifest | null = null;
  for (const m of manifests) {
    const prefix = m.dir === "" ? "" : `${m.dir}/`;
    if (!repoRelativeFile.startsWith(prefix)) continue;
    if (best === null || m.dir.length > best.dir.length) best = m;
  }
  return best;
}

export type CrossRuntimeResolver = {
  resolve(callExpr: Node, callerId: string, callerFile: string): string | null;
  edges(): CrossRuntimeEdge[];
};

export type CrossRuntimeInput = {
  catalog: BindingCatalog;
  rootAbsolute: string;
  repoRoot: string;
  nodeToId: Map<Node, string>;
};

function buildMethodIndex(
  nodeToId: Map<Node, string>,
  toRepoRelative: (file: string) => string,
): Map<string, string[]> {
  const index = new Map<string, string[]>();
  for (const [node, id] of nodeToId) {
    if (!Node.isMethodDeclaration(node)) continue;
    const className = enclosingClassName(node);
    if (className === null) continue;
    const repoFile = toRepoRelative(toRelativeFileOf(node));
    for (const dir of ancestorDirs(repoFile)) {
      const key = methodKey(dir, className, node.getName());
      const bucket = index.get(key);
      if (bucket === undefined) index.set(key, [id]);
      else bucket.push(id);
    }
  }
  for (const bucket of index.values()) bucket.sort((a, b) => a.localeCompare(b));
  return index;
}

export function methodIdsOfClasses(
  nodeToId: Map<Node, string>,
  classNames: ReadonlySet<string>,
): Set<string> {
  const ids = new Set<string>();
  for (const [node, id] of nodeToId) {
    if (!Node.isMethodDeclaration(node)) continue;
    const className = enclosingClassName(node);
    if (className !== null && classNames.has(className)) ids.add(id);
  }
  return ids;
}

function toRelativeFileOf(node: Node): string {
  return node.getSourceFile().getFilePath().split(path.sep).join("/");
}

function ancestorDirs(file: string): string[] {
  const parts = file.split("/");
  const dirs: string[] = [""];
  let acc = "";
  for (const part of parts.slice(0, -1)) {
    acc = acc === "" ? part : `${acc}/${part}`;
    dirs.push(acc);
  }
  return dirs;
}

function serviceDirectories(catalog: BindingCatalog): Map<string, string | null> {
  const dirs = new Map<string, string | null>();
  for (const m of catalog.manifests) {
    dirs.set(m.service, dirs.has(m.service) ? null : m.dir);
  }
  return dirs;
}

function resolveTarget(
  index: Map<string, string[]>,
  decl: BindingDecl,
  targetDir: string | null,
  method: string,
): { calleeId: string; reason: null } | { calleeId: null; reason: CrossRuntimeEdge["reason"] } {
  if (targetDir === null) return { calleeId: null, reason: "target-service-unknown" };
  const hits = index.get(methodKey(targetDir, decl.targetClass, method)) ?? [];
  if (hits.length === 0) return { calleeId: null, reason: "target-not-loaded" };
  if (hits.length > 1) return { calleeId: null, reason: "ambiguous-target" };
  return { calleeId: hits[0], reason: null };
}

export function createCrossRuntimeResolver(input: CrossRuntimeInput): CrossRuntimeResolver {
  const { catalog, rootAbsolute, repoRoot, nodeToId } = input;
  const repoPosix = repoRoot.split(path.sep).join("/");
  const toRepoRelative = (absPosix: string): string =>
    absPosix.startsWith(`${repoPosix}/`) ? absPosix.slice(repoPosix.length + 1) : absPosix;

  const index = buildMethodIndex(nodeToId, toRepoRelative);
  const dirOfService = serviceDirectories(catalog);
  const collected: CrossRuntimeEdge[] = [];

  return {
    resolve(callExpr, callerId, callerFile) {
      const shape = bindingCallShape(callExpr);
      if (shape === null) return null;
      const repoFile = toRepoRelative(
        `${rootAbsolute.split(path.sep).join("/")}/${callerFile}`.replace(/\/\.\//g, "/"),
      );
      const owner = ownerOf(catalog.manifests, repoFile);
      if (owner === null) return null;
      const decl = owner.bindings.find((b) => b.binding === shape.binding);
      if (decl === undefined) return null;

      const targetDir = dirOfService.get(decl.targetService) ?? null;
      const { calleeId, reason } = resolveTarget(index, decl, targetDir, shape.method);
      const edge: CrossRuntimeEdge = {
        binding: decl.binding,
        bindingKind: decl.kind,
        callerId,
        calleeId,
        line: callExpr.getStartLineNumber(),
        method: shape.method,
        ownerService: owner.service,
        reason,
        targetClass: decl.targetClass,
        targetService: decl.targetService,
      };
      collected.push(edge);
      return calleeId ?? unresolvedCalleeId({ ...decl, method: shape.method });
    },
    edges() {
      const seen = new Set<string>();
      const out: CrossRuntimeEdge[] = [];
      for (const e of collected) {
        const key = `${e.callerId}|${e.line}|${e.binding}|${e.method}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(e);
      }
      out.sort(
        (a, b) =>
          a.callerId.localeCompare(b.callerId) ||
          a.line - b.line ||
          a.binding.localeCompare(b.binding) ||
          a.method.localeCompare(b.method),
      );
      return out;
    },
  };
}
