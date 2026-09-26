import path from "node:path";
import type { TypeContext } from "../checker/context.js";
import * as ts from "../engine/tsgo.js";
import type { CrossRuntimeEdge } from "../schema.js";
import type { ResolvedCallee } from "./callee/resolve.js";
import type { BindingCatalog, BindingDecl, ServiceManifest } from "./wrangler-config.js";

type BindingTarget = { targetService: string; targetClass: string; method: string };

function unresolvedCallee(target: BindingTarget): ResolvedCallee {
  return {
    calleeId: `unresolved:${target.targetService}.${target.targetClass}.${target.method}`,
    declaration: `${target.targetService}:${target.targetClass}.${target.method}`,
  };
}

function methodKey(dir: string, className: string, method: string): string {
  return `${dir}|${className}|${method}`;
}

function enclosingClassName(ctx: TypeContext, node: ts.Node): string | null {
  const parent = node.parent;
  if (parent === undefined) return null;
  if (ts.isClassDeclaration(parent)) return parent.name?.text ?? "default";
  if (ts.isClassExpression(parent)) {
    if (parent.name !== undefined) return parent.name.text;
    const owner = parent.parent;
    if (owner !== undefined && ts.isVariableDeclaration(owner)) return ctx.text(owner.name);
  }
  return null;
}

function bindingCallShape(
  ctx: TypeContext,
  callExpr: ts.CallExpression,
): { binding: string; method: string } | null {
  const method = callExpr.expression;
  if (!ts.isPropertyAccessExpression(method)) return null;
  const receiver = method.expression;
  if (!ts.isPropertyAccessExpression(receiver)) return null;
  return { binding: ctx.text(receiver.name), method: ctx.text(method.name) };
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
  resolve(callExpr: ts.CallExpression, callerId: string, callerFile: string): ResolvedCallee | null;
  edges(): CrossRuntimeEdge[];
};

export type CrossRuntimeInput = {
  catalog: BindingCatalog;
  rootAbsolute: string;
  repoRoot: string;
  ctx: TypeContext;
};

function topLevelVariables(source: ts.SourceFile): ts.VariableDeclaration[] {
  const out: ts.VariableDeclaration[] = [];
  for (const statement of source.statements) {
    if (ts.isVariableStatement(statement)) out.push(...statement.declarationList.declarations);
  }
  return out;
}

function wrappingExportNames(ctx: TypeContext, method: ts.Node, className: string): string[] {
  const names: string[] = [];
  for (const variable of topLevelVariables(method.getSourceFile())) {
    const initializer = variable.initializer;
    if (initializer === undefined || !ts.isCallExpression(initializer)) continue;
    const wrapsClass = initializer.arguments.some(
      (argument) => ts.isIdentifier(argument) && ctx.text(argument) === className,
    );
    if (wrapsClass) names.push(ctx.text(variable.name));
  }
  return names;
}

function classNamesOf(ctx: TypeContext, method: ts.Node): string[] {
  const className = enclosingClassName(ctx, method);
  if (className === null) return [];
  return [className, ...wrappingExportNames(ctx, method, className)];
}

function buildMethodIndex(
  ctx: TypeContext,
  toRepoRelative: (file: string) => string,
): Map<string, string[]> {
  const index = new Map<string, string[]>();
  for (const [node, id] of ctx.nodeToId) {
    if (!ts.isMethodDeclaration(node)) continue;
    const repoFile = toRepoRelative(absoluteFileOf(ctx, node));
    for (const className of classNamesOf(ctx, node)) {
      for (const dir of ancestorDirs(repoFile)) {
        const key = methodKey(dir, className, ctx.text(node.name));
        const bucket = index.get(key);
        if (bucket === undefined) index.set(key, [id]);
        else bucket.push(id);
      }
    }
  }
  for (const bucket of index.values()) bucket.sort((a, b) => a.localeCompare(b));
  return index;
}

export function methodIdsOfClasses(ctx: TypeContext, classNames: ReadonlySet<string>): Set<string> {
  const ids = new Set<string>();
  for (const [node, id] of ctx.nodeToId) {
    if (!ts.isMethodDeclaration(node)) continue;
    if (classNamesOf(ctx, node).some((name) => classNames.has(name))) ids.add(id);
  }
  return ids;
}

function absoluteFileOf(ctx: TypeContext, node: ts.Node): string {
  const source = node.getSourceFile();
  return (ctx.unitOf(source)?.absolutePath ?? source.fileName).split(path.sep).join("/");
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

const WORKFLOW_STARTERS: ReadonlySet<string> = new Set(["create", "createBatch"]);

function invokedMethod(decl: BindingDecl, calledMethod: string): string | null {
  switch (decl.kind) {
    case "service":
    case "durable-object":
      return calledMethod;
    case "workflow":
      return WORKFLOW_STARTERS.has(calledMethod) ? "run" : null;
    default: {
      const exhaustive: never = decl.kind;
      return exhaustive;
    }
  }
}

function invokedBinding(
  owner: ServiceManifest,
  shape: { binding: string; method: string },
): { decl: BindingDecl; targetMethod: string } | null {
  const decl = owner.bindings.find((b) => b.binding === shape.binding);
  if (decl === undefined) return null;
  const targetMethod = invokedMethod(decl, shape.method);
  return targetMethod === null ? null : { decl, targetMethod };
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

function distinctEdges(collected: readonly CrossRuntimeEdge[]): CrossRuntimeEdge[] {
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
}

export function createCrossRuntimeResolver(input: CrossRuntimeInput): CrossRuntimeResolver {
  const { catalog, rootAbsolute, repoRoot, ctx } = input;
  const repoPosix = repoRoot.split(path.sep).join("/");
  const toRepoRelative = (absPosix: string): string =>
    absPosix.startsWith(`${repoPosix}/`) ? absPosix.slice(repoPosix.length + 1) : absPosix;

  const index = buildMethodIndex(ctx, toRepoRelative);
  const dirOfService = serviceDirectories(catalog);
  const collected: CrossRuntimeEdge[] = [];

  return {
    resolve(callExpr, callerId, callerFile) {
      const shape = bindingCallShape(ctx, callExpr);
      if (shape === null) return null;
      const repoFile = toRepoRelative(
        `${rootAbsolute.split(path.sep).join("/")}/${callerFile}`.replace(/\/\.\//g, "/"),
      );
      const owner = ownerOf(catalog.manifests, repoFile);
      if (owner === null) return null;
      const invoked = invokedBinding(owner, shape);
      if (invoked === null) return null;
      const { decl, targetMethod } = invoked;

      const targetDir = dirOfService.get(decl.targetService) ?? null;
      const { calleeId, reason } = resolveTarget(index, decl, targetDir, targetMethod);
      const edge: CrossRuntimeEdge = {
        binding: decl.binding,
        bindingKind: decl.kind,
        callerId,
        calleeId,
        line: ctx.startLine(callExpr),
        method: shape.method,
        ownerService: owner.service,
        reason,
        targetClass: decl.targetClass,
        targetService: decl.targetService,
      };
      collected.push(edge);
      return calleeId === null
        ? unresolvedCallee({ ...decl, method: shape.method })
        : { calleeId, declaration: null };
    },
    edges() {
      return distinctEdges(collected);
    },
  };
}
