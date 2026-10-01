import { field, nodeField, type SyntaxNode } from "./file.js";

// Every local a binding pattern introduces: `db`, `db = x`, `...db`, `{ db }`, `[db]`, and a
// TypeScript parameter property's `private db`.
export function patternNames(pattern: SyntaxNode | null): string[] {
  if (pattern === null) return [];
  switch (pattern.type) {
    case "Identifier":
      return [String(field(pattern, "name"))];
    case "AssignmentPattern":
      return patternNames(nodeField(pattern, "left"));
    case "RestElement":
      return patternNames(nodeField(pattern, "argument"));
    case "TSParameterProperty":
      return patternNames(nodeField(pattern, "parameter"));
    case "Property":
      return patternNames(nodeField(pattern, "value"));
    case "ObjectPattern":
      return (field(pattern, "properties") as SyntaxNode[]).flatMap(patternNames);
    case "ArrayPattern":
      return (field(pattern, "elements") as (SyntaxNode | null)[]).flatMap(patternNames);
    default:
      return [];
  }
}
