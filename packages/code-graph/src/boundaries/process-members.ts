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
