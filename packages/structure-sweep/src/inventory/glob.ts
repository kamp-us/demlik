/**
 * A repo-relative path glob: `**` spans directories, `*` and `?` stay inside one segment, and every
 * other character matches itself. A pattern with no wildcard also matches everything under it, so
 * `packages/design` excludes the folder.
 */
export function globMatcher(pattern: string): (path: string) => boolean {
  const trimmed = pattern.replace(/^\.\//, "").replace(/\/+$/, "");
  let source = "";
  for (let i = 0; i < trimmed.length; i++) {
    const c = trimmed[i] as string;
    if (c === "*" && trimmed[i + 1] === "*") {
      const slash = trimmed[i + 2] === "/";
      source += slash ? "(?:.*/)?" : ".*";
      i += slash ? 2 : 1;
    } else if (c === "*") source += "[^/]*";
    else if (c === "?") source += "[^/]";
    else source += c.replace(/[\\^$.|+()[\]{}]/g, "\\$&");
  }
  const regex = new RegExp(`^${source}(?:/.*)?$`);
  return (path) => regex.test(path);
}

/** Whether any of `patterns` matches `path`. */
export function anyGlob(
  patterns: readonly string[],
): (path: string) => boolean {
  const matchers = patterns.map(globMatcher);
  return (path) => matchers.some((matches) => matches(path));
}
