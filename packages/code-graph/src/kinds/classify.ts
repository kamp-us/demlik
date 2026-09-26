import { type EntryReach, EntryReachSchema, type FunctionNode, type NodeKind } from "../schema.js";
import { type CompiledRule, compileGroup, matchingRules, type NodeKindRules } from "./rules.js";

export type ClassifyContext = {
  crossRuntimeTargets: ReadonlySet<string>;
  durableObjectMethods: ReadonlySet<string>;
  baseClassEntries: ReadonlyMap<string, readonly string[]>;
  declaredGuards: ReadonlyMap<string, readonly string[]>;
  conventionEntries: ReadonlyMap<string, readonly string[]>;
};

export type CompiledKindRules = {
  entryNames: CompiledRule[];
  entryBaseClasses: CompiledRule[];
  entryGuardProperties: CompiledRule[];
  entryFilePatterns: CompiledRule[];
  authNames: CompiledRule[];
  authCallees: CompiledRule[];
  effectDeclarations: CompiledRule[];
  testSupport: CompiledRule[];
  entryReach: ReachRule[];
};

type ReachRule = { readonly reach: EntryReach; readonly patterns: readonly RegExp[] };

export function compileKindRules(rules: NodeKindRules): CompiledKindRules {
  return {
    entryNames: compileGroup(rules.entryNames),
    entryBaseClasses: compileGroup(rules.entryBaseClasses),
    entryGuardProperties: compileGroup(rules.entryGuardProperties),
    entryFilePatterns: compileGroup(rules.entryFilePatterns),
    authNames: compileGroup(rules.authNames),
    authCallees: compileGroup(rules.authCallees),
    effectDeclarations: compileGroup(rules.effectDeclarations),
    testSupport: compileGroup(rules.testSupportFilePatterns),
    entryReach: [
      { reach: "service-binding", patterns: rules.entryReach["service-binding"].map(toRegExp) },
      { reach: "platform", patterns: rules.entryReach.platform.map(toRegExp) },
    ],
  };
}

export function calleeSimpleName(calleeId: string): string {
  if (calleeId.startsWith("external:")) return calleeId.slice("external:".length);
  if (calleeId.startsWith("unresolved:")) {
    const parts = calleeId.slice("unresolved:".length).split(".");
    return parts[parts.length - 1] ?? calleeId;
  }
  const afterColon = calleeId.slice(calleeId.lastIndexOf(":") + 1);
  const hash = afterColon.indexOf("#");
  return hash === -1 ? afterColon : afterColon.slice(0, hash);
}

function calleeEvidence(fn: FunctionNode, rules: readonly CompiledRule[]): string[] {
  const out = new Set<string>();
  for (const call of fn.edges?.calls ?? []) {
    for (const key of matchingRules(rules, calleeSimpleName(call.calleeId))) out.add(key);
  }
  return [...out].sort((a, b) => a.localeCompare(b));
}

function declarationEvidence(fn: FunctionNode, rules: readonly CompiledRule[]): string[] {
  const out = new Set<string>();
  for (const call of fn.edges?.calls ?? []) {
    if (call.declaration === null) continue;
    for (const key of matchingRules(rules, call.declaration)) out.add(key);
  }
  return [...out].sort((a, b) => a.localeCompare(b));
}

function entryEvidence(
  fn: FunctionNode,
  rules: CompiledKindRules,
  context: ClassifyContext,
): string[] {
  const out = new Set<string>();
  for (const key of matchingRules(rules.entryNames, fn.name)) out.add(key);
  if (fn.isExported) {
    for (const key of matchingRules(rules.entryFilePatterns, fn.file)) out.add(key);
  }
  if (context.crossRuntimeTargets.has(fn.id)) out.add("cross-service-callee");
  if (context.durableObjectMethods.has(fn.id)) out.add("durable-object-class");
  for (const key of context.baseClassEntries.get(fn.id) ?? []) out.add(key);
  for (const key of context.conventionEntries.get(fn.id) ?? []) out.add(key);
  return [...out].sort((a, b) => a.localeCompare(b));
}

const toRegExp = (source: string): RegExp => new RegExp(source);

function evidenceReach(key: string, rules: readonly ReachRule[]): EntryReach {
  return rules.find((rule) => rule.patterns.some((p) => p.test(key)))?.reach ?? "public";
}

function entryReach(evidence: readonly string[], rules: readonly ReachRule[]): EntryReach {
  const reaches = new Set(evidence.map((key) => evidenceReach(key, rules)));
  return EntryReachSchema.options.find((reach) => reaches.has(reach)) ?? "public";
}

export function classifyFunction(
  fn: FunctionNode,
  rules: CompiledKindRules,
  context: ClassifyContext,
): NodeKind {
  const entry = fn.isTest ? [] : entryEvidence(fn, rules, context);
  if (entry.length > 0) {
    return {
      kind: "entry",
      evidence: entry,
      guards: [...(context.declaredGuards.get(fn.id) ?? [])],
      reach: entryReach(entry, rules.entryReach),
    };
  }

  const auth = [
    ...new Set([
      ...matchingRules(rules.authNames, fn.name),
      ...calleeEvidence(fn, rules.authCallees),
    ]),
  ].sort((a, b) => a.localeCompare(b));
  if (auth.length > 0) return { kind: "auth", evidence: auth };

  const effect = declarationEvidence(fn, rules.effectDeclarations);
  if (effect.length > 0) return { kind: "effect", evidence: effect };

  return { kind: "plain" };
}

export type KindCensus = { entry: number; auth: number; effect: number; plain: number };

export function kindCensus(functions: readonly FunctionNode[]): KindCensus {
  const census: KindCensus = { entry: 0, auth: 0, effect: 0, plain: 0 };
  for (const fn of functions) {
    const nk = fn.nodeKind;
    if (nk === null) continue;
    switch (nk.kind) {
      case "entry":
        census.entry++;
        break;
      case "auth":
        census.auth++;
        break;
      case "effect":
        census.effect++;
        break;
      case "plain":
        census.plain++;
        break;
      default: {
        const exhaustive: never = nk;
        return exhaustive;
      }
    }
  }
  return census;
}
