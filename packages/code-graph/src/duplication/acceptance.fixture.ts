export const CLONE_FILES: Readonly<Record<string, string>> = {
  "a.ts": 'export function first(f) { return { kind: "Bad", text: f.text, list: f.list }; }',
  "b.ts": "export function second(f) { return {kind:'Bad',text:f.text,list:f.list}; }",
  "c.ts": 'export const third = (f) => ({ kind: "Bad", /* detail */ text: f.text, list: f.list });',
};

export const CLUMP_FILES: Readonly<Record<string, string>> = {
  "a.ts": 'run(x, schemaA, tableA, ctx, "A.b", { outage: O });',
  "b.ts": 'run(y, schemaA, tableA, other, "C.d", { outage: O });',
  "c.ts": 'run(z, schemaA, tableA, next, "E.f", { outage: O });',
};

export const POSITIONAL_CALLS = ["A", "B", "C"]
  .flatMap((tag) =>
    Array.from(
      { length: 3 },
      () => `run(c, s${tag}, t${tag}, ctx, "${tag}.a", { outage: O${tag} });`,
    ),
  )
  .join("\n");
