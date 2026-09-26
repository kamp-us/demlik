import {
  child,
  children,
  FUNCTION_TYPES,
  keyedChildren,
  type Node,
} from "./ast.js";

/** One declaration: the identifier that introduced it. Redeclaring a `var` reuses it. */
interface Binding {
  readonly at: Node;
}

class Scope {
  private readonly declared = new Map<string, Binding>();

  constructor(
    private readonly parent: Scope | null,
    private readonly isFunction: boolean,
  ) {}

  /** The nearest function scope: where a `var` lands. */
  get function(): Scope {
    return this.isFunction || this.parent === null
      ? this
      : this.parent.function;
  }

  declare(name: string, at: Node): Binding {
    const existing = this.declared.get(name);
    if (existing !== undefined) return existing;
    const binding = { at };
    this.declared.set(name, binding);
    return binding;
  }

  resolve(name: string): Binding | undefined {
    return this.declared.get(name) ?? this.parent?.resolve(name);
  }
}

const KEYED = new Set([
  "Property",
  "MethodDefinition",
  "PropertyDefinition",
  "AccessorProperty",
]);

const LABELLED = new Set([
  "LabeledStatement",
  "BreakStatement",
  "ContinueStatement",
]);

const BLOCK_SCOPES = new Set([
  "BlockStatement",
  "StaticBlock",
  "ForStatement",
  "ForInStatement",
  "ForOfStatement",
]);

/** Whether the identifier at `parent[key]` is a name — a property, key or label — never a reference. */
const isName = (parent: Node, key: string): boolean =>
  (parent.type === "MemberExpression" &&
    key === "property" &&
    !parent.computed) ||
  (KEYED.has(parent.type) && key === "key" && !parent.computed) ||
  (LABELLED.has(parent.type) && key === "label") ||
  (parent.type === "ClassExpression" && key === "id") ||
  parent.type === "MetaProperty";

/**
 * The neutral name of every identifier in `fn` that is one of its own parameters or locals:
 * `v0`, `v1`, … in declaration order. Resolution follows the scopes — function, block, `catch` —
 * so a name declared only inside a nested function or block renames nothing outside it, and an
 * identifier that resolves to no declaration here is free and gets no entry. Two declarations
 * that share a name in different scopes are two locals. A parameter's default value declares
 * nothing (`parameter-defaults-ignored`), and `fn`'s own name stays free, so a recursive call
 * still names its callee.
 */
export function neutralNames(fn: Node): ReadonlyMap<Node, string> {
  const bound = new Map<Node, Binding>();
  const references: { readonly node: Node; readonly scope: Scope }[] = [];

  const declare = (id: Node, scope: Scope) =>
    bound.set(id, scope.declare(String(id.name), id));

  const pattern = (node: Node | null, scope: Scope): void => {
    if (node === null) return;
    switch (node.type) {
      case "Identifier":
        declare(node, scope);
        return;
      case "AssignmentPattern":
        pattern(child(node, "left"), scope);
        return;
      case "RestElement":
        pattern(child(node, "argument"), scope);
        return;
      case "ArrayPattern":
        for (const element of children(node, "elements"))
          pattern(element, scope);
        return;
      case "ObjectPattern":
        for (const property of children(node, "properties"))
          pattern(
            property.type === "RestElement"
              ? property
              : child(property, "value"),
            scope,
          );
        return;
      case "TSParameterProperty":
        pattern(child(node, "parameter"), scope);
        return;
    }
  };

  const functionScope = (node: Node, outer: Scope | null): void => {
    const scope = new Scope(outer, true);
    for (const param of children(node, "params")) pattern(param, scope);
    const body = child(node, "body");
    if (body?.type === "BlockStatement")
      for (const statement of children(body, "body")) visit(statement, scope);
    else if (body !== null) visit(body, scope);
  };

  const visit = (node: Node, scope: Scope): void => {
    if (FUNCTION_TYPES.has(node.type)) {
      const id = child(node, "id");
      if (node.type === "FunctionDeclaration" && id !== null)
        declare(id, scope);
      functionScope(node, scope);
      return;
    }
    switch (node.type) {
      case "Identifier":
        references.push({ node, scope });
        return;
      case "VariableDeclaration": {
        const target = node.kind === "var" ? scope.function : scope;
        for (const declarator of children(node, "declarations")) {
          pattern(child(declarator, "id"), target);
          const init = child(declarator, "init");
          if (init !== null) visit(init, scope);
        }
        return;
      }
      case "ClassDeclaration": {
        const id = child(node, "id");
        if (id !== null) declare(id, scope);
        for (const [key, c] of keyedChildren(node))
          if (key !== "id") visit(c, scope);
        return;
      }
      case "CatchClause": {
        const inner = new Scope(scope, false);
        pattern(child(node, "param"), inner);
        const body = child(node, "body");
        if (body !== null) visit(body, inner);
        return;
      }
      case "SwitchStatement": {
        // The discriminant is evaluated before the case block's lexical scope exists.
        const discriminant = child(node, "discriminant");
        if (discriminant !== null) visit(discriminant, scope);
        const block = new Scope(scope, false);
        for (const switchCase of children(node, "cases"))
          visit(switchCase, block);
        return;
      }
    }
    const inner = BLOCK_SCOPES.has(node.type) ? new Scope(scope, false) : scope;
    for (const [key, c] of keyedChildren(node))
      if (!(c.type === "Identifier" && isName(node, key))) visit(c, inner);
  };

  functionScope(fn, null);
  for (const { node, scope } of references) {
    const binding = scope.resolve(String(node.name));
    if (binding !== undefined) bound.set(node, binding);
  }

  const order = [...new Set(bound.values())].sort(
    (a, b) => a.at.start - b.at.start,
  );
  return new Map(
    [...bound].map(([node, binding]) => [node, `v${order.indexOf(binding)}`]),
  );
}
