import { ts } from "ts-morph";

export const COMMENT_BUCKETS = [
  "pragma",
  "license",
  "marker",
  "commented-out-code",
  "banner",
  "file-header",
  "docblock",
  "block",
  "inline",
] as const;

export type CommentBucket = (typeof COMMENT_BUCKETS)[number];

export type CommentClass = "protected" | "mechanical" | "prose";

export function classOf(bucket: CommentBucket): CommentClass {
  switch (bucket) {
    case "pragma":
    case "license":
    case "marker":
      return "protected";
    case "banner":
    case "commented-out-code":
      return "mechanical";
    case "file-header":
    case "docblock":
    case "block":
    case "inline":
      return "prose";
  }
}

export function bucketsIn(commentClass: CommentClass): readonly CommentBucket[] {
  return COMMENT_BUCKETS.filter((bucket) => classOf(bucket) === commentClass);
}

export function bucketRecord<T>(make: () => T): Record<CommentBucket, T> {
  return {
    pragma: make(),
    license: make(),
    marker: make(),
    "commented-out-code": make(),
    banner: make(),
    "file-header": make(),
    docblock: make(),
    block: make(),
    inline: make(),
  };
}

const PRAGMA =
  /(@ts-(expect-error|ignore|nocheck)|biome-ignore|eslint-(disable|enable)|prettier-ignore|oxlint-disable|(c8|v8|istanbul) ignore|@vitest-environment|@jsxImportSource|<reference\s)/;

const LICENSE = /(Copyright|SPDX-License-Identifier|Licensed under)/;

const MARKER = /(\b(TODO|FIXME|HACK|XXX)\b|@deprecated\b)/;

const BANNER_PUNCTUATION_ONLY = /^[-=*_#~+ ]+$/;
const BANNER_RULE = /^[-=*_#~]{3,}/;
const BANNER_DIVIDER = /^[-=*_#~ ]{2,}\s*\S[\s\S]*?\s*[-=*_#~ ]{2,}$/;

const CODE_TAIL = /[;{},)]$/;
const CODE_HEAD =
  /^(const|let|var|return|if|else|for|while|switch|import|export|await|async|function|class|type|interface|enum|throw|new)\b|^[})]|^<\/?[A-Z]/;

export function commentBody(text: string): string {
  if (text.startsWith("//")) return text.slice(2).trim();
  return text
    .replace(/^\/\*\*?/, "")
    .replace(/\*\/$/, "")
    .split("\n")
    .map((line) => line.replace(/^\s*\*(?!\/)[ \t]?/, "").trimEnd())
    .join("\n")
    .trim();
}

function isLoneLiteral(statements: ts.NodeArray<ts.Statement>): boolean {
  const only = statements.length === 1 ? statements[0] : undefined;
  if (only === undefined || !ts.isExpressionStatement(only)) return false;
  const kind = only.expression.kind;
  return (
    kind === ts.SyntaxKind.Identifier ||
    kind === ts.SyntaxKind.StringLiteral ||
    kind === ts.SyntaxKind.NoSubstitutionTemplateLiteral
  );
}

function parsesAsTypeScript(body: string): boolean {
  const parsed = ts.createSourceFile(
    "comment.tsx",
    body,
    ts.ScriptTarget.Latest,
    false,
    ts.ScriptKind.TSX,
  );
  const diagnostics = parsed.parseDiagnostics;
  if (!Array.isArray(diagnostics) || diagnostics.length > 0) return false;
  if (parsed.statements.length === 0) return false;
  return !isLoneLiteral(parsed.statements);
}

export function isCommentedOutCode(body: string): boolean {
  if (!CODE_TAIL.test(body) && !CODE_HEAD.test(body)) return false;
  return parsesAsTypeScript(body);
}

export function isBanner(body: string): boolean {
  if (body.length === 0) return false;
  return BANNER_PUNCTUATION_ONLY.test(body) || BANNER_RULE.test(body) || BANNER_DIVIDER.test(body);
}

function protectedBucketOf(body: string, pos: number): CommentBucket | null {
  if (PRAGMA.test(body)) return "pragma";
  if (pos === 0 && LICENSE.test(body)) return "license";
  if (MARKER.test(body)) return "marker";
  return null;
}

export type CommentShape = {
  text: string;
  pos: number;
  fileHeaderCandidate: boolean;
};

export function classifyComment(shape: CommentShape): CommentBucket {
  const body = commentBody(shape.text);

  const protectedBucket = protectedBucketOf(body, shape.pos);
  if (protectedBucket !== null) return protectedBucket;

  if (isCommentedOutCode(body)) return "commented-out-code";
  if (isBanner(body)) return "banner";

  if (!shape.text.startsWith("/*")) return "inline";
  if (shape.fileHeaderCandidate) return "file-header";
  return shape.text.startsWith("/**") ? "docblock" : "block";
}
