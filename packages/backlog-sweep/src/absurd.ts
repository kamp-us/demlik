/** The exhaustiveness witness: a `switch` over a closed union ends here, so a new arm fails to compile. */
export function absurd(value: never): never {
  throw new Error(`unreachable: ${JSON.stringify(value)}`);
}
