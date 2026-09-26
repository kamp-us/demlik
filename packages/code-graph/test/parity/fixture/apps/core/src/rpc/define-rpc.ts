export interface Spec<P, R> { parameters: P; execute: (p: P) => Promise<R> }
export function defineRpc<P, R>(spec: Spec<P, R>): (input: P) => Promise<R> {
  return async (input: P) => spec.execute(input);
}
export function eager<P>(spec: { setup(): void; execute(p: P): void }): (input: P) => void {
  spec.setup();
  return () => {};
}
