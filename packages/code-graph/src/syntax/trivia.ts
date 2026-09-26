// TypeScript's comment-range semantics (`ts.getLeadingCommentRanges` / `getTrailingCommentRanges`)
// over raw text, so a count taken on oxc's tree lands on exactly the comments the ts-morph engine
// counted. A leading scan starts at the end of the previous token and collects only what follows a
// line break; a trailing scan collects what sits on the same line and stops at the break.

export type CommentRange = { readonly pos: number; readonly end: number };

const LF = 10;
const CR = 13;

function isLineBreak(ch: number): boolean {
  return ch === LF || ch === CR || ch === 0x2028 || ch === 0x2029;
}

const SINGLE_LINE_SPACES: ReadonlySet<number> = new Set([
  32, 9, 11, 12, 0xa0, 0x85, 0x1680, 0x202f, 0x205f, 0x3000, 0xfeff,
]);

function isWhiteSpaceSingleLine(ch: number): boolean {
  return SINGLE_LINE_SPACES.has(ch) || (ch >= 0x2000 && ch <= 0x200b);
}

function isWhiteSpaceLike(ch: number): boolean {
  return isWhiteSpaceSingleLine(ch) || isLineBreak(ch);
}

function shebangEnd(text: string): number {
  if (!text.startsWith("#!")) return 0;
  let pos = 2;
  while (pos < text.length && !isLineBreak(text.charCodeAt(pos))) pos++;
  return pos;
}

function scanComment(text: string, pos: number): number {
  const next = text.charCodeAt(pos + 1);
  let at = pos + 2;
  if (next === 47) {
    while (at < text.length && !isLineBreak(text.charCodeAt(at))) at++;
    return at;
  }
  while (at < text.length) {
    if (text.charCodeAt(at) === 42 && text.charCodeAt(at + 1) === 47) return at + 2;
    at++;
  }
  return at;
}

type Scan = { pos: number; collecting: boolean; done: boolean };

function lineBreakWidth(text: string, pos: number): number {
  const ch = text.charCodeAt(pos);
  if (ch === CR) return text.charCodeAt(pos + 1) === LF ? 2 : 1;
  return ch === LF ? 1 : 0;
}

function isInlineSpace(ch: number): boolean {
  return ch === 9 || ch === 11 || ch === 12 || ch === 32 || (ch > 127 && isWhiteSpaceLike(ch));
}

function commentStartsAt(text: string, pos: number): boolean {
  if (text.charCodeAt(pos) !== 47) return false;
  const next = text.charCodeAt(pos + 1);
  return next === 47 || next === 42;
}

// One step of TypeScript's `iterateCommentRanges`: past a line break, a run of spaces, or a
// comment, which is recorded when the scan is collecting. Anything else ends the scan.
function step(text: string, scan: Scan, trailing: boolean, out: CommentRange[]): void {
  const breakWidth = lineBreakWidth(text, scan.pos);
  if (breakWidth > 0) {
    scan.pos += breakWidth;
    scan.done = trailing;
    scan.collecting = true;
    return;
  }
  if (isInlineSpace(text.charCodeAt(scan.pos))) {
    scan.pos++;
    return;
  }
  if (!commentStartsAt(text, scan.pos)) {
    scan.done = true;
    return;
  }
  const end = scanComment(text, scan.pos);
  if (scan.collecting) out.push({ pos: scan.pos, end });
  scan.pos = end;
}

function commentRanges(text: string, start: number, trailing: boolean): CommentRange[] {
  const out: CommentRange[] = [];
  const scan: Scan =
    start === 0
      ? { pos: shebangEnd(text), collecting: true, done: false }
      : { pos: start, collecting: trailing, done: false };
  while (!scan.done && scan.pos >= 0 && scan.pos < text.length) step(text, scan, trailing, out);
  return out;
}

export class Trivia {
  private readonly commentStartByEnd = new Map<number, number>();
  private readonly leadingCache = new Map<number, readonly CommentRange[]>();
  private readonly trailingCache = new Map<number, readonly CommentRange[]>();

  constructor(
    readonly text: string,
    comments: readonly { readonly start: number; readonly end: number }[],
  ) {
    for (const c of comments) this.commentStartByEnd.set(c.end, c.start);
  }

  // Where TypeScript's node that starts at `start` has its `pos`: the end of the token before it,
  // found by stepping back over whitespace and whole comments.
  previousTokenEnd(start: number): number {
    let at = start;
    for (;;) {
      while (at > 0 && isWhiteSpaceLike(this.text.charCodeAt(at - 1))) at--;
      const commentStart = this.commentStartByEnd.get(at);
      if (commentStart === undefined || commentStart >= at) return at;
      at = commentStart;
    }
  }

  leadingAt(start: number): readonly CommentRange[] {
    const cached = this.leadingCache.get(start);
    if (cached !== undefined) return cached;
    const ranges = commentRanges(this.text, this.previousTokenEnd(start), false);
    this.leadingCache.set(start, ranges);
    return ranges;
  }

  trailingAt(end: number): readonly CommentRange[] {
    const cached = this.trailingCache.get(end);
    if (cached !== undefined) return cached;
    const ranges = commentRanges(this.text, end, true);
    this.trailingCache.set(end, ranges);
    return ranges;
  }

  // The first position at or after `from` that is not whitespace or a comment.
  nextTokenStart(from: number): number {
    let at = from;
    for (;;) {
      while (at < this.text.length && isWhiteSpaceLike(this.text.charCodeAt(at))) at++;
      if (!commentStartsAt(this.text, at)) return at;
      at = scanComment(this.text, at);
    }
  }
}
