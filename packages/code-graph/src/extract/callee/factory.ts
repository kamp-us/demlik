import {
  type ArrowFunction,
  type CallExpression,
  type FunctionDeclaration,
  type FunctionExpression,
  Node,
  SyntaxKind,
} from "ts-morph";

type Factory = FunctionDeclaration | ArrowFunction | FunctionExpression;

type ForwardedMember = { readonly parameter: number; readonly member: string };

function declarationOf(expression: Node): Node | undefined {
  const symbol = expression.getSymbol();
  return (symbol?.getAliasedSymbol() ?? symbol)?.getDeclarations()[0];
}

function factoryOf(decl: Node | undefined): Factory | undefined {
  if (Node.isFunctionDeclaration(decl)) return decl.getImplementation() ?? decl;
  if (!Node.isVariableDeclaration(decl)) return undefined;
  const initializer = decl.getInitializer();
  return Node.isArrowFunction(initializer) || Node.isFunctionExpression(initializer)
    ? initializer
    : undefined;
}

function returnedFunctions(factory: Factory): Node[] {
  const body = factory.getBody();
  if (Node.isArrowFunction(body) || Node.isFunctionExpression(body)) return [body];
  const out: Node[] = [];
  body?.forEachDescendant((node, traversal) => {
    if (Node.isFunctionLikeDeclaration(node)) {
      traversal.skip();
      return;
    }
    if (!Node.isReturnStatement(node)) return;
    const returned = node.getExpression();
    if (Node.isArrowFunction(returned) || Node.isFunctionExpression(returned)) out.push(returned);
  });
  return out;
}

function forwardedMembers(factory: Factory): ForwardedMember[] {
  const parameters = factory.getParameters().map((p) => p.getNameNode());
  const out: ForwardedMember[] = [];
  for (const returned of returnedFunctions(factory)) {
    for (const call of returned.getDescendantsOfKind(SyntaxKind.CallExpression)) {
      const callee = call.getExpression();
      if (!Node.isPropertyAccessExpression(callee)) continue;
      const receiver = declarationOf(callee.getExpression());
      const parameter = parameters.findIndex((name) => name.getParent() === receiver);
      if (parameter !== -1) out.push({ parameter, member: callee.getName() });
    }
  }
  return out;
}

function memberImplementation(config: Node | undefined, member: string): Node | undefined {
  if (!Node.isObjectLiteralExpression(config)) return undefined;
  const property = config.getProperty(member);
  if (Node.isMethodDeclaration(property)) return property;
  return Node.isPropertyAssignment(property) ? property.getInitializer() : undefined;
}

export type FactoryResolver = (callExpr: CallExpression) => string[];

export function createFactoryResolver(nodeToId: Map<Node, string>): FactoryResolver {
  const membersByFactory = new Map<Factory, ForwardedMember[]>();
  const membersOf = (factory: Factory): ForwardedMember[] => {
    const cached = membersByFactory.get(factory);
    if (cached !== undefined) return cached;
    const members = forwardedMembers(factory);
    membersByFactory.set(factory, members);
    return members;
  };

  return (callExpr) => {
    const produced = declarationOf(callExpr.getExpression());
    if (!Node.isVariableDeclaration(produced)) return [];
    const construction = produced.getInitializer();
    if (!Node.isCallExpression(construction)) return [];
    const factory = factoryOf(declarationOf(construction.getExpression()));
    if (factory === undefined) return [];
    const ids = new Set<string>();
    for (const { parameter, member } of membersOf(factory)) {
      const implementation = memberImplementation(construction.getArguments()[parameter], member);
      const id = implementation === undefined ? undefined : nodeToId.get(implementation);
      if (id !== undefined) ids.add(id);
    }
    return [...ids].sort((a, b) => a.localeCompare(b));
  };
}
