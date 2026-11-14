// The order a list is written in when it must not depend on the machine's locale.
export function byText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
