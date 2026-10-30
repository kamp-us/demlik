// `named` is withheld as referenced-in-non-test-file: consumer.ts names it.
export function named(): number {
  return d();
}

// Called only by `named`.
export function d(): number {
  return 4;
}

// Nothing calls it.
export function f(): number {
  return 6;
}
