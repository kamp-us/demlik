// A path glob compiled to an anchored RegExp over a `/`-separated relative path.
//
//   `**/`   zero or more whole directories      `*`  any run of characters but `/`
//   `**`    (last segment) anything, `/` too     `?`  one character but `/`
//   `{a,b}` any one alternative, each itself a glob; `{,src/}` makes a prefix optional
//
// Every other character is literal, `[` and `(` included, so a path with a framework dynamic
// segment (`[slug]`) or route group (`(marketing)`) is matched by `**`, never by a class.
export class GlobSyntaxError extends Error {}

const LITERAL = /[.+^$()|[\]\\]/g;

function compileRange(glob: string, start: number, stops: string): { source: string; end: number } {
  let source = "";
  let i = start;
  while (i < glob.length && !stops.includes(glob.charAt(i))) {
    const c = glob.charAt(i);
    if (glob.startsWith("**/", i)) {
      source += "(?:[^/]*/)*";
      i += 3;
    } else if (glob.startsWith("**", i)) {
      source += ".*";
      i += 2;
    } else if (c === "*") {
      source += "[^/]*";
      i += 1;
    } else if (c === "?") {
      source += "[^/]";
      i += 1;
    } else if (c === "{") {
      const group = compileAlternatives(glob, i + 1);
      source += group.source;
      i = group.end;
    } else if (c === "}" || c === ",") {
      throw new GlobSyntaxError(`unbalanced "${c}" at ${i} in glob "${glob}"`);
    } else {
      source += c.replace(LITERAL, "\\$&");
      i += 1;
    }
  }
  return { source, end: i };
}

function compileAlternatives(glob: string, start: number): { source: string; end: number } {
  const alternatives: string[] = [];
  let i = start;
  for (;;) {
    const part = compileRange(glob, i, ",}");
    alternatives.push(part.source);
    if (part.end >= glob.length) {
      throw new GlobSyntaxError(`unclosed "{" in glob "${glob}"`);
    }
    i = part.end + 1;
    if (glob.charAt(part.end) === "}") return { source: `(?:${alternatives.join("|")})`, end: i };
  }
}

export function globToRegExp(glob: string): RegExp {
  const { source } = compileRange(glob, 0, "");
  return new RegExp(`^${source}$`);
}
