export function expectEqual<T>(actual: T, expected: NoInfer<T>): boolean {
  return actual === expected;
}
