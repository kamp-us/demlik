import { type Program, parseSnippet } from "../engine/oxc.js";

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

type Statement = Program["body"][number];

function isLoneLiteral(statements: readonly Statement[]): boolean {
  const only = statements.length === 1 ? statements[0] : undefined;
  if (only === undefined || only.type !== "ExpressionStatement") return false;
  const expression = only.expression;
  if (expression.type === "Identifier") return true;
  if (expression.type === "Literal") return typeof expression.value === "string";
  return expression.type === "TemplateLiteral" && expression.expressions.length === 0;
}

// TypeScript's parser accepts a `return` outside any function and leaves it to the checker to
// object; oxc's refuses it, so a body that fails as a module is read again as a function body.
function snippetStatements(body: string): readonly Statement[] | null {
  const program = parseSnippet(body);
  if (program !== null) return program.body;
  const wrapped = parseSnippet(`function snippet() {\n${body}\n}`);
  const fn = wrapped?.body[0];
  return fn?.type === "FunctionDeclaration" && fn.body !== null ? fn.body.body : null;
}

function parsesAsTypeScript(body: string): boolean {
  const statements = snippetStatements(body);
  if (statements === null || statements.length === 0) return false;
  return !isLoneLiteral(statements);
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
