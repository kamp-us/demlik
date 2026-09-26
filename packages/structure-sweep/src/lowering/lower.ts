import { readFileSync } from "node:fs";
import { parseSync } from "oxc-parser";
import { z } from "zod";
import { canonicalJson, type Stage, type StageInput } from "./artifact.js";
import {
  type Fact,
  type SourceSpan,
  sourceSpan,
  unknownValue,
} from "./fact.js";

// ── the graph input ───────────────────────────────────────────────────────

const CallSite = z.object({ calleeId: z.string(), line: z.number().int() });

/** One function node of a code-graph `--graph` JSON file, as far as lowering reads it. */
export const GraphFunction = z.object({
  id: z.string().min(1),
  file: z.string().min(1),
  startLine: z.number().int().min(1),
  endLine: z.number().int().min(1),
  edges: z
    .object({ calls: z.array(CallSite) })
    .nullable()
    .default(null),
});

export type GraphFunction = z.infer<typeof GraphFunction>;

export const LoweringGraph = z.object({ functions: z.array(GraphFunction) });

export type LoweringGraph = z.infer<typeof LoweringGraph>;

/** A code-graph `--graph` JSON file, parsed to the fields the lowering stages read. */
export const readLoweringGraph = (path: string): LoweringGraph =>
  LoweringGraph.parse(JSON.parse(readFileSync(path, "utf8")));

// ── the lowered form ──────────────────────────────────────────────────────

/**
 * One operand, normalized. A `local` is a parameter or local renamed to its neutral name; a `free`
 * identifier keeps its name, as does a static member path rooted at one (`flags.enforceSeats`) or at
 * `this`, because stage 3 resolves those. `expression` is anything else, rendered with the neutral
 * names and carrying the free paths it mentions.
 */
export type Term =
  | { readonly kind: "local"; readonly name: string }
  | { readonly kind: "free"; readonly path: string }
  | {
      readonly kind: "member";
      readonly object: Term;
      readonly property: string;
    }
  | CallTerm
  | { readonly kind: "literal"; readonly raw: string }
  | {
      readonly kind: "expression";
      readonly text: string;
      readonly free: readonly string[];
      readonly locals: readonly string[];
    };

/** A call. `calleeId` is the code-graph function it resolves to, when one call edge on its line names it. */
export interface CallTerm {
  readonly kind: "call";
  readonly callee: Term;
  readonly args: readonly Term[];
  readonly calleeId: string | null;
}

export type EqualityOperator = "===" | "==";
export type CompareOperator = EqualityOperator | "<" | "<=" | ">" | ">=";

/**
 * One test in a path condition. A leaf carries its polarity: `!` flips it, and `!==` / `!=` are the
 * negated `===` / `==`. `any` is a disjunction kept as one atom, each disjunct a conjunction; the
 * condition is in negation normal form, so `any` itself has no polarity.
 */
export type Atom =
  | {
      readonly kind: "compare";
      readonly operator: CompareOperator;
      readonly left: Term;
      readonly right: Term;
      readonly polarity: boolean;
      readonly span: SourceSpan;
    }
  | {
      readonly kind: "predicate";
      readonly call: CallTerm;
      readonly polarity: boolean;
      readonly span: SourceSpan;
    }
  | {
      readonly kind: "in";
      readonly key: Term;
      readonly object: Term;
      readonly polarity: boolean;
      readonly span: SourceSpan;
    }
  | {
      readonly kind: "instanceof";
      readonly value: Term;
      readonly type: Term;
      readonly polarity: boolean;
      readonly span: SourceSpan;
    }
  | {
      readonly kind: "truthy";
      readonly subject: Term;
      readonly polarity: boolean;
      readonly span: SourceSpan;
    }
  | {
      readonly kind: "any";
      readonly disjuncts: readonly (readonly Atom[])[];
      readonly span: SourceSpan;
    };

/** Where a branch leads: the closed union of the three outcomes a branch can have. */
export type Outcome =
  | { readonly kind: "return"; readonly value: Term | null }
  | { readonly kind: "throw"; readonly value: Term }
  | { readonly kind: "call"; readonly call: CallTerm };

/** A `const` local the branch mentions, and the expression it was bound to. */
export interface Binding {
  readonly local: string;
  readonly init: Term;
}

/** One branch of one function: the conjunction it runs under, and where it leads. */
export interface LoweredBranch {
  /** The code-graph id of the function the branch is in. */
  readonly function: string;
  readonly path: readonly Atom[];
  readonly outcome: Outcome;
  readonly bindings: readonly Binding[];
}

// ── the named rules ───────────────────────────────────────────────────────

/**
 * The prototype resolver rules this stage ports, by name. Each is pinned by its own fixture on
 * held-out synthetic cases. `parameter-defaults-ignored`: a parameter's default value contributes
 * no atom, no binding and no call; the parameter lowers to its neutral name alone.
 */
export const LOWERING_RULES = ["parameter-defaults-ignored"] as const;

export type LoweringRule = (typeof LOWERING_RULES)[number];

/** Calls rooted here are logging and are dropped. A caller adds roots; `console` is always one. */
export const DEFAULT_LOGGING_ROOTS = ["console"] as const;

// ── rendering ─────────────────────────────────────────────────────────────

/** A term as text, with the neutral names: what a later stage and Jev read. */
export function renderTerm(term: Term): string {
  switch (term.kind) {
    case "local":
      return term.name;
    case "free":
      return term.path;
    case "member":
      return `${renderTerm(term.object)}.${term.property}`;
    case "call":
      return `${renderTerm(term.callee)}(${term.args.map(renderTerm).join(", ")})`;
    case "literal":
      return term.raw;
    case "expression":
      return term.text;
  }
}

/** An atom as text: `¬` marks a negated leaf, `∨` joins an `any`'s disjuncts. */
export function renderAtom(atom: Atom): string {
  const sign = (polarity: boolean, text: string) =>
    polarity ? text : `¬(${text})`;
  switch (atom.kind) {
    case "compare":
      return sign(
        atom.polarity,
        `${renderTerm(atom.left)} ${atom.operator} ${renderTerm(atom.right)}`,
      );
    case "predicate":
      return sign(atom.polarity, renderTerm(atom.call));
    case "in":
      return sign(
        atom.polarity,
        `${renderTerm(atom.key)} in ${renderTerm(atom.object)}`,
      );
    case "instanceof":
      return sign(
        atom.polarity,
        `${renderTerm(atom.value)} instanceof ${renderTerm(atom.type)}`,
      );
    case "truthy":
      return sign(atom.polarity, renderTerm(atom.subject));
    case "any":
      return `(${atom.disjuncts.map((d) => d.map(renderAtom).join(" ∧ ")).join(" ∨ ")})`;
  }
}

export function renderOutcome(outcome: Outcome): string {
  switch (outcome.kind) {
    case "return":
      return outcome.value === null
        ? "return"
        : `return ${renderTerm(outcome.value)}`;
    case "throw":
      return `throw ${renderTerm(outcome.value)}`;
    case "call":
      return `call ${renderTerm(outcome.call)}`;
  }
}

/** The free identifiers a term mentions: stage 3's input. */
export function freeIdentifiers(term: Term): readonly string[] {
  switch (term.kind) {
    case "local":
    case "literal":
      return [];
    case "free":
      return [term.path];
    case "member":
      return freeIdentifiers(term.object);
    case "call":
      return [
        ...freeIdentifiers(term.callee),
        ...term.args.flatMap(freeIdentifiers),
      ];
    case "expression":
      return term.free;
  }
}

/** Every term an atom tests, leaves of an `any` included. */
export function atomTerms(atom: Atom): readonly Term[] {
  switch (atom.kind) {
    case "compare":
      return [atom.left, atom.right];
    case "predicate":
      return [atom.call];
    case "in":
      return [atom.key, atom.object];
    case "instanceof":
      return [atom.value, atom.type];
    case "truthy":
      return [atom.subject];
    case "any":
      return atom.disjuncts.flat().flatMap(atomTerms);
  }
}

export function outcomeTerms(outcome: Outcome): readonly Term[] {
  switch (outcome.kind) {
    case "return":
      return outcome.value === null ? [] : [outcome.value];
    case "throw":
      return [outcome.value];
    case "call":
      return [outcome.call];
  }
}

function localsOf(term: Term): readonly string[] {
  switch (term.kind) {
    case "local":
      return [term.name];
    case "member":
      return localsOf(term.object);
    case "call":
      return [...localsOf(term.callee), ...term.args.flatMap(localsOf)];
    case "expression":
      return term.locals;
    case "free":
    case "literal":
      return [];
  }
}

// ── the stage ─────────────────────────────────────────────────────────────

const LoweringInput = z.strictObject({
  file: z.string().min(1),
  source: z.string(),
  functions: z.array(GraphFunction),
  loggingRoots: z.array(z.string().min(1)),
});

export interface LoweringOptions {
  /** The file's path as the graph names it. */
  readonly file: string;
  readonly source: string;
  /** The graph's function nodes; those in other files are ignored. */
  readonly functions: readonly GraphFunction[];
  /** Logging roots besides `console`, such as `logger`. */
  readonly loggingRoots?: readonly string[];
}

/**
 * A file's stage-2 input. Everything the stage reads is in `content` — the source, the function nodes
 * and the logging roots — so a change to any of them changes the key.
 */
export function loweringInput(options: LoweringOptions): StageInput {
  const loggingRoots = [
    ...new Set([...DEFAULT_LOGGING_ROOTS, ...(options.loggingRoots ?? [])]),
  ].sort();
  return {
    content: canonicalJson({
      file: options.file,
      source: options.source,
      functions: options.functions.filter((fn) => fn.file === options.file),
      loggingRoots,
    }),
    artifacts: [],
  };
}

/** Stage 2: one fact per branch of every function the graph names in the file. */
export const lowerStage: Stage<LoweredBranch> = {
  name: "lower",
  version: "1",
  run: async (input) => {
    const parsed = LoweringInput.parse(JSON.parse(input.content));
    return lowerFile(parsed);
  },
};

type Node = {
  readonly type: string;
  readonly start: number;
  readonly end: number;
} & Readonly<Record<string, unknown>>;

const isNode = (value: unknown): value is Node =>
  value !== null &&
  typeof value === "object" &&
  typeof (value as { type?: unknown }).type === "string";

const child = (node: Node, key: string): Node | null => {
  const value = node[key];
  return isNode(value) ? value : null;
};

const children = (node: Node, key: string): readonly Node[] => {
  const value = node[key];
  return Array.isArray(value) ? value.filter(isNode) : [];
};

const FUNCTION_TYPES = new Set([
  "FunctionDeclaration",
  "FunctionExpression",
  "ArrowFunctionExpression",
]);

const TYPE_KEYS = new Set([
  "typeAnnotation",
  "typeArguments",
  "typeParameters",
  "returnType",
  "decorators",
]);

function nodeChildren(node: Node): readonly Node[] {
  const out: Node[] = [];
  for (const [key, value] of Object.entries(node)) {
    if (TYPE_KEYS.has(key)) continue;
    if (isNode(value)) out.push(value);
    else if (Array.isArray(value)) out.push(...value.filter(isNode));
  }
  return out;
}

class Lines {
  private readonly starts: number[] = [0];
  constructor(text: string) {
    for (let i = 0; i < text.length; i++)
      if (text.charCodeAt(i) === 10) this.starts.push(i + 1);
  }
  of(position: number): number {
    let low = 0;
    let high = this.starts.length - 1;
    while (low < high) {
      const mid = (low + high + 1) >> 1;
      if ((this.starts[mid] ?? 0) <= position) low = mid;
      else high = mid - 1;
    }
    return low + 1;
  }
}

interface Located {
  readonly node: Node;
  readonly startLines: ReadonlySet<number>;
  readonly endLine: number;
}

const WRAPPERS = new Set([
  "MethodDefinition",
  "Property",
  "PropertyDefinition",
  "ExportNamedDeclaration",
  "ExportDefaultDeclaration",
]);

/** Every function node, outermost first, with the start lines code-graph may report for it. */
function locateFunctions(program: Node, lines: Lines): readonly Located[] {
  const out: Located[] = [];
  const visit = (node: Node, parent: Node | null) => {
    if (FUNCTION_TYPES.has(node.type)) {
      const startLines = new Set([lines.of(node.start)]);
      if (parent !== null && WRAPPERS.has(parent.type))
        startLines.add(lines.of(parent.start));
      out.push({ node, startLines, endLine: lines.of(node.end) });
    }
    for (const c of nodeChildren(node)) visit(c, node);
  };
  visit(program, null);
  return out;
}

/** Lower every function the input names; one that does not parse is one `undetermined` fact. */
export function lowerFile(
  input: z.infer<typeof LoweringInput>,
): readonly Fact<LoweredBranch>[] {
  const lang = input.file.endsWith(".tsx")
    ? "tsx"
    : input.file.endsWith(".jsx")
      ? "jsx"
      : input.file.endsWith(".js") || input.file.endsWith(".mjs")
        ? "js"
        : "ts";
  const result = parseSync(input.file, input.source, {
    lang,
    sourceType: "module",
    preserveParens: false,
  });
  const lines = new Lines(input.source);
  const program = result.program as unknown as Node;
  const errorLines = result.errors.flatMap((error) =>
    error.labels.length === 0
      ? [Number.NaN]
      : error.labels.map((label) => lines.of(label.start)),
  );
  const located = locateFunctions(program, lines);
  const logging = new Set(input.loggingRoots);
  const facts: Fact<LoweredBranch>[] = [];
  const functions = input.functions
    .filter((fn) => fn.file === input.file)
    .sort((a, b) => a.startLine - b.startLine || (a.id < b.id ? -1 : 1));
  for (const fn of functions) {
    const undetermined = (): Fact<LoweredBranch> => ({
      id: fn.id,
      span: sourceSpan(
        fn.file,
        fn.startLine,
        Math.max(fn.startLine, fn.endLine),
      ),
      value: unknownValue("undetermined"),
    });
    const broken = errorLines.some(
      (line) =>
        Number.isNaN(line) || (line >= fn.startLine && line <= fn.endLine),
    );
    const found = located.find(
      (l) => l.startLines.has(fn.startLine) && l.endLine === fn.endLine,
    );
    if (broken || found === undefined) {
      facts.push(undetermined());
      continue;
    }
    const branches = new FunctionLowering(
      input.source,
      lines,
      fn,
      logging,
    ).lower(found.node);
    branches.forEach((branch, n) => {
      facts.push({
        id: `${fn.id}@${n}`,
        span: branch.span,
        value: {
          _tag: "known",
          value: branch.branch,
          basis: { _tag: "derived" },
        },
      });
    });
  }
  return facts;
}

const unwrapExpression = (node: Node): Node => {
  let current = node;
  for (;;) {
    switch (current.type) {
      case "ParenthesizedExpression":
      case "TSAsExpression":
      case "TSSatisfiesExpression":
      case "TSNonNullExpression":
      case "TSTypeAssertion":
      case "TSInstantiationExpression":
      case "ChainExpression":
      case "AwaitExpression": {
        const inner =
          child(current, "expression") ?? child(current, "argument");
        if (inner === null) return current;
        current = inner;
        break;
      }
      default:
        return current;
    }
  }
};

const EQUALITY: Readonly<Record<string, [EqualityOperator, boolean]>> = {
  "===": ["===", true],
  "!==": ["===", false],
  "==": ["==", true],
  "!=": ["==", false],
};

const RELATIONAL = new Set(["<", "<=", ">", ">="]);

type Terminates = boolean;

interface EmittedBranch {
  readonly branch: LoweredBranch;
  readonly span: SourceSpan;
}

/** One function's lowering: its neutral names, its bindings and the branches its body walks to. */
class FunctionLowering {
  private readonly names = new Map<string, string>();
  private readonly bindings = new Map<string, Term>();
  private readonly branches: EmittedBranch[] = [];

  constructor(
    private readonly source: string,
    private readonly lines: Lines,
    private readonly fn: GraphFunction,
    private readonly logging: ReadonlySet<string>,
  ) {}

  lower(node: Node): readonly EmittedBranch[] {
    this.collectNames(node);
    const body = child(node, "body");
    if (body === null) return [];
    if (body.type === "BlockStatement") this.walk(children(body, "body"), []);
    else this.emit(body, [], { kind: "return", value: this.term(body) });
    return this.branches;
  }

  private span(node: Node): SourceSpan {
    return sourceSpan(
      this.fn.file,
      this.lines.of(node.start),
      this.lines.of(Math.max(node.start, node.end - 1)),
    );
  }

  /**
   * Neutral names in first-occurrence order: the parameters, then every name the body declares,
   * nested functions' included so a callback's parameter renames too. A parameter's default value
   * is not visited (`parameter-defaults-ignored`).
   */
  private collectNames(fn: Node): void {
    const declare = (name: string) => {
      if (!this.names.has(name)) this.names.set(name, `v${this.names.size}`);
    };
    const pattern = (node: Node | null): void => {
      if (node === null) return;
      switch (node.type) {
        case "Identifier":
          declare(String(node.name));
          return;
        case "AssignmentPattern":
          pattern(child(node, "left"));
          return;
        case "RestElement":
          pattern(child(node, "argument"));
          return;
        case "ArrayPattern":
          for (const element of children(node, "elements")) pattern(element);
          return;
        case "ObjectPattern":
          for (const property of children(node, "properties"))
            pattern(
              property.type === "RestElement"
                ? property
                : child(property, "value"),
            );
          return;
        case "TSParameterProperty":
          pattern(child(node, "parameter"));
          return;
      }
    };
    const visit = (node: Node): void => {
      if (FUNCTION_TYPES.has(node.type)) {
        if (node !== fn && node.type === "FunctionDeclaration")
          pattern(child(node, "id"));
        for (const param of children(node, "params")) pattern(param);
        const body = child(node, "body");
        if (body !== null) visit(body);
        return;
      }
      switch (node.type) {
        case "VariableDeclarator":
          pattern(child(node, "id"));
          break;
        case "CatchClause":
          pattern(child(node, "param"));
          break;
        case "ClassDeclaration":
          pattern(child(node, "id"));
          break;
      }
      for (const c of nodeChildren(node)) visit(c);
    };
    visit(fn);
  }

  private emit(at: Node, path: readonly Atom[], outcome: Outcome): void {
    const mentioned = new Set(
      [...path.flatMap(atomTerms), ...outcomeTerms(outcome)].flatMap(localsOf),
    );
    const bindings = [...this.bindings]
      .filter(([local]) => mentioned.has(local))
      .map(([local, init]) => ({ local, init }));
    this.branches.push({
      branch: { function: this.fn.id, path, outcome, bindings },
      span: this.span(at),
    });
  }

  private walk(
    statements: readonly Node[],
    start: readonly Atom[],
  ): Terminates {
    let path = start;
    for (const statement of statements) {
      const next = this.statement(statement, path);
      if (next === "terminates") return true;
      path = next;
    }
    return false;
  }

  /** Walk one statement; answer the path the statements after it run under, or that none do. */
  private statement(
    node: Node,
    path: readonly Atom[],
  ): readonly Atom[] | "terminates" {
    switch (node.type) {
      case "ReturnStatement": {
        const argument = child(node, "argument");
        this.emit(node, path, {
          kind: "return",
          value: argument === null ? null : this.term(argument),
        });
        return "terminates";
      }
      case "ThrowStatement": {
        const argument = child(node, "argument");
        this.emit(node, path, {
          kind: "throw",
          value:
            argument === null
              ? { kind: "literal", raw: "undefined" }
              : this.term(argument),
        });
        return "terminates";
      }
      case "BlockStatement":
        return this.walk(children(node, "body"), path) ? "terminates" : path;
      case "IfStatement": {
        const test = child(node, "test");
        const consequent = child(node, "consequent");
        const alternate = child(node, "alternate");
        if (test === null || consequent === null) return path;
        const holds = this.condition(test, true);
        const fails = this.condition(test, false);
        const thenExits = this.walk([consequent], [...path, ...holds]);
        const elseExits =
          alternate !== null && this.walk([alternate], [...path, ...fails]);
        if (thenExits && elseExits) return "terminates";
        if (thenExits) return [...path, ...fails];
        if (elseExits) return [...path, ...holds];
        return path;
      }
      case "ExpressionStatement": {
        const expression = child(node, "expression");
        if (expression !== null) this.effect(node, expression, path);
        return path;
      }
      case "VariableDeclaration": {
        if (node.kind === "const")
          for (const declarator of children(node, "declarations")) {
            const id = child(declarator, "id");
            const init = child(declarator, "init");
            if (id?.type === "Identifier" && init !== null) {
              const local = this.names.get(String(id.name));
              if (local !== undefined)
                this.bindings.set(local, this.term(init));
            }
          }
        return path;
      }
      case "SwitchStatement":
        this.switchStatement(node, path);
        return path;
      case "WhileStatement":
      case "DoWhileStatement": {
        const test = child(node, "test");
        const body = child(node, "body");
        if (body !== null)
          this.walk(
            [body],
            test === null ? path : [...path, ...this.condition(test, true)],
          );
        return path;
      }
      case "ForStatement":
      case "ForInStatement":
      case "ForOfStatement":
      case "LabeledStatement": {
        const body = child(node, "body");
        if (body !== null) this.walk([body], path);
        return path;
      }
      case "TryStatement": {
        const block = child(node, "block");
        const handler = child(node, "handler");
        const finalizer = child(node, "finalizer");
        const blockExits = block !== null && this.walk([block], path);
        const handlerBody = handler === null ? null : child(handler, "body");
        const handlerExits =
          handlerBody === null || this.walk([handlerBody], path);
        if (finalizer !== null) this.walk([finalizer], path);
        return blockExits && handlerExits ? "terminates" : path;
      }
      default:
        return path;
    }
  }

  /** A call statement, and the `a && f()` / `c ? f() : g()` forms that are conditional calls. */
  private effect(at: Node, expression: Node, path: readonly Atom[]): void {
    const node = unwrapExpression(expression);
    if (node.type === "CallExpression") {
      const call = this.term(node);
      if (call.kind !== "call" || this.isLogging(call)) return;
      if (path.length > 0) this.emit(at, path, { kind: "call", call });
      return;
    }
    if (node.type === "LogicalExpression") {
      const left = child(node, "left");
      const right = child(node, "right");
      if (left === null || right === null) return;
      if (node.operator === "&&")
        this.effect(at, right, [...path, ...this.condition(left, true)]);
      else if (node.operator === "||")
        this.effect(at, right, [...path, ...this.condition(left, false)]);
      return;
    }
    if (node.type === "ConditionalExpression") {
      const test = child(node, "test");
      const consequent = child(node, "consequent");
      const alternate = child(node, "alternate");
      if (test === null || consequent === null || alternate === null) return;
      this.effect(at, consequent, [...path, ...this.condition(test, true)]);
      this.effect(at, alternate, [...path, ...this.condition(test, false)]);
    }
  }

  private switchStatement(node: Node, path: readonly Atom[]): void {
    const discriminant = child(node, "discriminant");
    if (discriminant === null) return;
    const subject = this.term(discriminant);
    const tested: Atom[] = [];
    let pending: Atom[] = [];
    let hasDefault = false;
    const cases = children(node, "cases");
    for (const switchCase of cases) {
      const test = child(switchCase, "test");
      if (test === null) hasDefault = true;
      else {
        const atom = this.equality(switchCase, subject, this.term(test), true);
        pending.push(atom);
        tested.push(atom);
      }
      const consequent = children(switchCase, "consequent");
      if (consequent.length === 0) continue;
      const guard: Atom[] =
        hasDefault && test === null
          ? tested.flatMap((atom) => negate(atom))
          : pending.length === 1 && pending[0] !== undefined
            ? [pending[0]]
            : [
                {
                  kind: "any",
                  disjuncts: pending.map((a) => [a]),
                  span: this.span(switchCase),
                },
              ];
      this.walk(consequent, [...path, ...guard]);
      pending = [];
    }
  }

  private isLogging(call: CallTerm): boolean {
    if (call.callee.kind !== "free") return false;
    const [root, second] = call.callee.path.split(".");
    return (
      (root !== undefined && this.logging.has(root)) ||
      (root === "this" && second !== undefined && this.logging.has(second))
    );
  }

  // ── conditions ────────────────────────────────────────────────────────

  /** The conjunction `node` asserts when it evaluates to `polarity`, in negation normal form. */
  private condition(expression: Node, polarity: boolean): readonly Atom[] {
    const node = unwrapExpression(expression);
    if (node.type === "UnaryExpression" && node.operator === "!") {
      const argument = child(node, "argument");
      if (argument !== null) return this.condition(argument, !polarity);
    }
    if (node.type === "LogicalExpression" && node.operator !== "??") {
      const left = child(node, "left");
      const right = child(node, "right");
      if (left !== null && right !== null) {
        const conjunctive = (node.operator === "&&") === polarity;
        const l = this.condition(left, polarity);
        const r = this.condition(right, polarity);
        if (conjunctive) return [...l, ...r];
        return [
          {
            kind: "any",
            disjuncts: [...disjunctsOf(l), ...disjunctsOf(r)],
            span: this.span(node),
          },
        ];
      }
    }
    return [this.leaf(node, polarity)];
  }

  private leaf(node: Node, polarity: boolean): Atom {
    const span = this.span(node);
    if (node.type === "BinaryExpression") {
      const left = child(node, "left");
      const right = child(node, "right");
      const operator = String(node.operator);
      if (left !== null && right !== null) {
        const equality = EQUALITY[operator];
        if (equality !== undefined) {
          const [op, sign] = equality;
          return this.equality(
            node,
            this.term(left),
            this.term(right),
            sign === polarity,
            op,
          );
        }
        if (RELATIONAL.has(operator))
          return {
            kind: "compare",
            operator: operator as CompareOperator,
            left: this.term(left),
            right: this.term(right),
            polarity,
            span,
          };
        if (operator === "in")
          return {
            kind: "in",
            key: this.term(left),
            object: this.term(right),
            polarity,
            span,
          };
        if (operator === "instanceof")
          return {
            kind: "instanceof",
            value: this.term(left),
            type: this.term(right),
            polarity,
            span,
          };
      }
    }
    const term = this.term(node);
    if (term.kind === "call")
      return { kind: "predicate", call: term, polarity, span };
    return { kind: "truthy", subject: term, polarity, span };
  }

  /** An equality, with a literal operand always on the right. */
  private equality(
    at: Node,
    left: Term,
    right: Term,
    polarity: boolean,
    operator: EqualityOperator = "===",
  ): Atom {
    const [l, r] =
      left.kind === "literal" && right.kind !== "literal"
        ? [right, left]
        : [left, right];
    return {
      kind: "compare",
      operator,
      left: l,
      right: r,
      polarity,
      span: this.span(at),
    };
  }

  // ── terms ─────────────────────────────────────────────────────────────

  private term(expression: Node): Term {
    const node = unwrapExpression(expression);
    switch (node.type) {
      case "Identifier": {
        const name = String(node.name);
        if (name === "undefined") return { kind: "literal", raw: "undefined" };
        const local = this.names.get(name);
        return local === undefined
          ? { kind: "free", path: name }
          : { kind: "local", name: local };
      }
      case "ThisExpression":
        return { kind: "free", path: "this" };
      case "Literal":
        return { kind: "literal", raw: literalText(node) };
      case "TemplateLiteral":
        if (children(node, "expressions").length === 0)
          return {
            kind: "literal",
            raw: JSON.stringify(
              children(node, "quasis")
                .map((q) =>
                  String((q.value as { cooked?: string }).cooked ?? ""),
                )
                .join(""),
            ),
          };
        break;
      case "MemberExpression": {
        const object = child(node, "object");
        const property = child(node, "property");
        if (object === null || property === null) break;
        const name = node.computed
          ? property.type === "Literal" && typeof property.value === "string"
            ? property.value
            : null
          : property.type === "Identifier" ||
              property.type === "PrivateIdentifier"
            ? String(property.name)
            : null;
        if (name === null) break;
        const base = this.term(object);
        return base.kind === "free"
          ? { kind: "free", path: `${base.path}.${name}` }
          : { kind: "member", object: base, property: name };
      }
      case "CallExpression": {
        const callee = child(node, "callee");
        if (callee === null) break;
        const calleeTerm = this.term(callee);
        return {
          kind: "call",
          callee: calleeTerm,
          args: children(node, "arguments").map((arg) => this.term(arg)),
          calleeId: this.calleeIdOf(node, calleeTerm),
        };
      }
    }
    return this.expression(node);
  }

  /** The code-graph callee of a call: the one call edge on its line whose name ends the callee's path. */
  private calleeIdOf(node: Node, callee: Term): string | null {
    const line = this.lines.of(node.start);
    const rendered = renderTerm(callee);
    const last = rendered.slice(rendered.lastIndexOf(".") + 1);
    const candidates = (this.fn.edges?.calls ?? []).filter((c) => {
      if (c.line !== line) return false;
      const name = c.calleeId
        .slice(c.calleeId.lastIndexOf(":") + 1)
        .replace(/#\d+$/, "");
      return name === last || name.endsWith(`.${last}`);
    });
    const ids = [...new Set(candidates.map((c) => c.calleeId))];
    return ids.length === 1 ? (ids[0] ?? null) : null;
  }

  /** An identifier, `this`, or a static member chain over one; `null` for anything else. */
  private staticTerm(node: Node): Term | null {
    switch (node.type) {
      case "Identifier":
      case "ThisExpression":
        return this.term(node);
      case "MemberExpression": {
        const object = child(node, "object");
        const property = child(node, "property");
        if (object === null || property === null || node.computed) return null;
        if (
          property.type !== "Identifier" &&
          property.type !== "PrivateIdentifier"
        )
          return null;
        const base = this.staticTerm(unwrapExpression(object));
        if (base === null) return null;
        const name = String(property.name);
        return base.kind === "free"
          ? { kind: "free", path: `${base.path}.${name}` }
          : { kind: "member", object: base, property: name };
      }
      default:
        return null;
    }
  }

  /** Any other expression: its source text with locals renamed and strings double-quoted, and the free paths in it. */
  private expression(node: Node): Term {
    const edits: {
      local: string | null;
      start: number;
      end: number;
      text: string;
    }[] = [];
    const free: string[] = [];
    const visit = (n: Node, parent: Node | null, key: string | null): void => {
      if (n.type === "Literal" && typeof n.value === "string") {
        edits.push({
          local: null,
          start: n.start,
          end: n.end,
          text: JSON.stringify(n.value),
        });
        return;
      }
      if (
        n.type === "Identifier" ||
        n.type === "MemberExpression" ||
        n.type === "ThisExpression"
      ) {
        const isName =
          n.type === "Identifier" &&
          parent !== null &&
          ((parent.type === "MemberExpression" &&
            key === "property" &&
            !parent.computed) ||
            ((parent.type === "Property" ||
              parent.type === "MethodDefinition" ||
              parent.type === "PropertyDefinition") &&
              key === "key" &&
              !parent.computed));
        if (isName) return;
        const term = this.staticTerm(n);
        if (term?.kind === "free") {
          free.push(term.path);
          return;
        }
        if (term?.kind === "local" && n.type === "Identifier") {
          const shorthand =
            parent?.type === "Property" && parent.shorthand === true;
          edits.push({
            local: term.name,
            start: n.start,
            end: n.end,
            text: shorthand ? `${String(n.name)}: ${term.name}` : term.name,
          });
          return;
        }
      }
      for (const [k, value] of Object.entries(n)) {
        if (TYPE_KEYS.has(k)) continue;
        if (isNode(value)) visit(value, n, k);
        else if (Array.isArray(value))
          for (const v of value) if (isNode(v)) visit(v, n, k);
      }
    };
    visit(node, null, null);
    let text = "";
    let at = node.start;
    for (const edit of edits.sort((a, b) => a.start - b.start)) {
      if (edit.start < at) continue;
      text += this.source.slice(at, edit.start) + edit.text;
      at = edit.end;
    }
    text += this.source.slice(at, node.end);
    return {
      kind: "expression",
      text: text.replace(/\s+/g, " ").trim(),
      free: [...new Set(free)],
      locals: [
        ...new Set(
          edits.flatMap((edit) => (edit.local === null ? [] : [edit.local])),
        ),
      ],
    };
  }
}

function literalText(node: Node): string {
  const value = node.value;
  if (typeof value === "string") return JSON.stringify(value);
  if (value === null && typeof node.raw === "string" && node.raw !== "null")
    return node.raw;
  return String(value);
}

function disjunctsOf(
  conjunction: readonly Atom[],
): readonly (readonly Atom[])[] {
  const [only] = conjunction;
  if (conjunction.length === 1 && only?.kind === "any") return only.disjuncts;
  return [conjunction];
}

/** The negation of one atom, as a conjunction in negation normal form. */
export function negate(atom: Atom): readonly Atom[] {
  if (atom.kind !== "any") return [{ ...atom, polarity: !atom.polarity }];
  return atom.disjuncts.flatMap((disjunct): readonly Atom[] => {
    if (disjunct.length === 1 && disjunct[0] !== undefined)
      return negate(disjunct[0]);
    return [
      {
        kind: "any",
        disjuncts: disjunct.flatMap((a) => disjunctsOf(negate(a))),
        span: atom.span,
      },
    ];
  });
}
