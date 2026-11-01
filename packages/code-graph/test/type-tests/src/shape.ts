// Called only from the type test next to it.
export function onlyTypeTested(name: string): number {
  return name.length;
}

// Called only from the `*.type-test.ts` file next to it.
export function onlyTypeTestFileTested(name: string): number {
  return name.length;
}
