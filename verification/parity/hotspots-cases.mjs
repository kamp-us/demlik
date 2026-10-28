export const window = {
  sinceIso: "2019-12-31T00:00:00.000Z",
  untilIso: "2020-02-01T00:00:00.000Z",
  days: 32,
};
const pure = (id, files, functions, tracked, commits, limits = [0, 2, 99]) => ({
  id,
  mode: "pure",
  files,
  functions,
  tracked,
  commits,
  limits,
  window,
});
const mixed = (size) => {
  const files = Array.from(
    { length: size },
    (_, i) =>
      `${["a", "b", "c"][i % 3]}${String(size - i).padStart(3, "0")}.ts`,
  );
  return pure(
    `sort-${size}`,
    files,
    files.map((file, i) => ({ file, complexity: [1, "NaN", 2][i % 3] })),
    files,
    files.map((file) => [file, 1]),
    [0, 7, "NaN", "Infinity"],
  );
};
export const cases = [
  pure(
    "pure-order-owners",
    ["hot.ts", "zero.ts", "untracked.ts", "equal.ts"],
    [
      { file: "hot.ts", complexity: 3 },
      { file: "hot.ts", complexity: 4 },
      { file: "equal.ts", complexity: 7 },
      { file: "zero.ts", complexity: 100 },
    ],
    ["hot.ts", "equal.ts", "zero.ts"],
    [
      ["hot.ts", 3],
      ["equal.ts", 3],
    ],
    [0, 1.5, -1, "NaN", "Infinity"],
  ),
  pure(
    "pure-duplicates-utf16",
    [
      "é.ts",
      "e\u0301.ts",
      "a2.ts",
      "a10.ts",
      "é.ts",
      "\ud800.ts",
      "a\u0000.ts",
    ],
    [
      { file: "é.ts", complexity: 2 },
      { file: "e\u0301.ts", complexity: 4 },
      { file: "a2.ts", complexity: 2 },
      { file: "a10.ts", complexity: 2 },
      { file: "\ud800.ts", complexity: 2 },
    ],
    ["é.ts", "e\u0301.ts", "a2.ts", "a10.ts", "\ud800.ts"],
    [
      ["é.ts", 2],
      ["e\u0301.ts", 1],
      ["a2.ts", 2],
      ["a10.ts", 2],
      ["\ud800.ts", 2],
    ],
  ),
  pure("pure-empty", [], [], [], [], [0, "NaN", "Infinity"]),
  pure(
    "pure-no-history",
    ["z.ts", "a.ts", "z.ts"],
    [{ file: "z.ts", complexity: 99 }],
    [],
    [],
    [0, 2],
  ),
  {
    ...pure(
      "pure-numbers",
      ["a.ts", "b.ts", "c.ts", "d.ts", "e.ts", "zero.ts", "missing.ts"],
      [
        { file: "a.ts", complexity: "Infinity" },
        { file: "b.ts", complexity: "-Infinity" },
        { file: "c.ts", complexity: "NaN" },
        { file: "d.ts", complexity: 1e308 },
        { file: "d.ts", complexity: 1e308 },
        { file: "e.ts", complexity: "-0" },
        { file: "zero.ts", complexity: "Infinity" },
      ],
      ["a.ts", "b.ts", "c.ts", "d.ts", "e.ts", "zero.ts"],
      [
        ["a.ts", 1],
        ["b.ts", 1],
        ["c.ts", 1],
        ["d.ts", 1],
        ["e.ts", 1],
        ["zero.ts", 0],
      ],
      [0, -1, 1.9, "NaN", "Infinity", "-Infinity"],
    ),
    window: { ...window, days: "NaN" },
  },
  mixed(63),
  mixed(64),
  mixed(65),
  {
    id: "options-valid",
    mode: "options",
    pairs: [
      ["\ufeff 00090\u2029", "00020"],
      ["0", "0"],
      ["9".repeat(100), "9".repeat(400)],
      ["42", "\u00a0 3 \u3000"],
    ],
  },
  {
    id: "options-refusal-order",
    mode: "options",
    pairs: [
      ["bad", "also bad"],
      ["1", "-1"],
      ["\u200b1", "0"],
      ["١", "0"],
      ["", "2"],
      ["1.5", "2"],
      ["1e2", "0"],
      ["1", "x\ud800\u0000"],
    ],
  },
  { id: "repo-wide", mode: "load", rootRole: "repo", realGraph: true, window },
  {
    id: "repo-window-repeat",
    mode: "load",
    rootRole: "repo",
    realGraph: true,
    window: { ...window, sinceIso: "2020-01-01T12:00:00.000Z", days: 30 },
    extraWindow: {
      sinceIso: "2030-01-01T00:00:00.000Z",
      untilIso: "2030-01-02T00:00:00.000Z",
      days: 1,
    },
  },
  {
    id: "repo-subdir",
    mode: "load",
    rootRole: "subdir",
    realGraph: true,
    window,
  },
  {
    id: "repo-symlink",
    mode: "load",
    rootRole: "symlink",
    realGraph: true,
    window,
  },
  { id: "missing-root", mode: "load", rootRole: "missing", window },
  { id: "nonrepo-root", mode: "load", rootRole: "nonrepo", window },
  { id: "no-head", mode: "load", rootRole: "nohead", window },
  ...["top", "head", "tracked", "log"].map((fail) => ({
    id: `git-fail-${fail}`,
    mode: "load",
    rootRole: "controlled",
    controlled: { fail },
    window,
  })),
  {
    id: "git-duplicates-raw-paths",
    mode: "load",
    rootRole: "controlled",
    controlled: { fail: null },
    window,
  },
  {
    id: "git-buffer-2mib",
    mode: "load",
    rootRole: "controlled",
    controlled: { fail: null, bytes: 2 * 1024 * 1024 },
    window,
  },
  {
    id: "git-buffer-65mib",
    mode: "load",
    rootRole: "controlled",
    controlled: { fail: null, bytes: 65 * 1024 * 1024 },
    window,
  },
];
if (cases.length !== 24 || new Set(cases.map((x) => x.id)).size !== 24)
  throw new Error("exact24 unique profiles");
