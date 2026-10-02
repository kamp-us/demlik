// The members the running process has, read by name: every string-keyed property on `process` and
// up its prototype chain, so EventEmitter's `on` counts. A name is read, never a value, because
// reading `process.stdin` opens a stream. Which members exist depends on the Node version, the
// platform (`getuid` is POSIX-only) and how the process was launched (`send` needs an IPC channel),
// so the set carries the version and platform it was read on for a refusal to name. Read once at
// the config edge; it gates a `doors` declaration and nothing else, so a ledger and a report never
// depend on the host that wrote them.
export type ProcessMembers = {
  readonly node: string;
  readonly platform: NodeJS.Platform;
  readonly names: ReadonlySet<string>;
};

export function runningProcessMembers(): ProcessMembers {
  const names = new Set<string>();
  for (let link: object | null = process; link !== null; link = Object.getPrototypeOf(link)) {
    for (const name of Object.getOwnPropertyNames(link)) names.add(name);
  }
  return { node: process.version, platform: process.platform, names };
}

// "Did you mean": commander's rule, which every `--flag` typo on this CLI already answers by. Optimal
// string alignment distance of at most 3 and a similarity above 0.4. Case does not count, and a tie
// goes to the smaller name, so one typo names the same candidate on every run.
const MAX_DISTANCE = 3;
const MIN_SIMILARITY = 0.4;

// Insert, delete, substitute, or swap two neighbours, each part of the word edited once.
function editDistance(a: string, b: string): number {
  const d: number[][] = [];
  const at = (i: number, j: number): number => d[i]?.[j] ?? 0;
  const swapped = (i: number, j: number): number =>
    i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]
      ? at(i - 2, j - 2) + 1
      : Number.POSITIVE_INFINITY;
  const cell = (i: number, j: number): number => {
    if (i === 0 || j === 0) return i + j;
    const substitution = at(i - 1, j - 1) + (a[i - 1] === b[j - 1] ? 0 : 1);
    return Math.min(at(i - 1, j) + 1, at(i, j - 1) + 1, substitution, swapped(i, j));
  };
  for (let i = 0; i <= a.length; i++) {
    const row: number[] = [];
    d.push(row);
    for (let j = 0; j <= b.length; j++) row[j] = cell(i, j);
  }
  return at(a.length, b.length);
}

type Match = { readonly name: string; readonly distance: number };

const closer = (a: Match, b: Match): boolean =>
  a.distance === b.distance ? a.name < b.name : a.distance < b.distance;

function matchOf(typed: string, name: string): Match | null {
  const distance = editDistance(typed, name.toLowerCase());
  const length = Math.max(typed.length, name.length);
  const near = distance <= MAX_DISTANCE && (length - distance) / length > MIN_SIMILARITY;
  return near ? { name, distance } : null;
}

// The candidate nearest to a mistyped word, or null when none is near enough to name.
export function nearestName(word: string, names: Iterable<string>): string | null {
  const typed = word.toLowerCase();
  let best: Match | null = null;
  for (const name of names) {
    const match = matchOf(typed, name);
    if (match !== null && (best === null || closer(match, best))) best = match;
  }
  return best?.name ?? null;
}
