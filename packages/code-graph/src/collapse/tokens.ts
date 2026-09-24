const STOPWORDS = new Set([
  "a",
  "all",
  "an",
  "and",
  "args",
  "arg",
  "as",
  "at",
  "build",
  "by",
  "cb",
  "compute",
  "create",
  "data",
  "do",
  "each",
  "ensure",
  "execute",
  "fn",
  "for",
  "from",
  "get",
  "handle",
  "has",
  "id",
  "in",
  "info",
  "init",
  "is",
  "item",
  "key",
  "kind",
  "list",
  "load",
  "make",
  "map",
  "name",
  "new",
  "of",
  "on",
  "one",
  "opt",
  "opts",
  "option",
  "options",
  "or",
  "params",
  "parse",
  "prop",
  "props",
  "read",
  "render",
  "resolve",
  "result",
  "run",
  "subscribe",
  "set",
  "the",
  "to",
  "type",
  "use",
  "value",
  "with",
  "write",
]);

const SUFFIXES = [
  "ations",
  "ation",
  "izes",
  "ized",
  "izing",
  "ize",
  "ings",
  "ing",
  "ers",
  "er",
  "es",
  "s",
];

function stem(token: string): string {
  for (const suffix of SUFFIXES) {
    if (token.length > suffix.length + 2 && token.endsWith(suffix)) {
      return token.slice(0, token.length - suffix.length);
    }
  }
  return token;
}

function split(name: string): string[] {
  return name
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .split(/[^A-Za-z0-9]+/)
    .filter((part) => part.length > 0)
    .map((part) => part.toLowerCase());
}

export function nameTokens(name: string): string[] {
  const out = new Set<string>();
  for (const part of split(name)) {
    if (STOPWORDS.has(part)) continue;
    const stemmed = stem(part);
    if (STOPWORDS.has(stemmed) || stemmed.length < 2) continue;
    out.add(stemmed);
  }
  return [...out].sort((a, b) => a.localeCompare(b));
}
