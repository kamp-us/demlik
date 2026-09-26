import { arrow, route } from "./shapes";

function helperUnderTest(): number {
  return route("a") + 1;
}

export async function scenario(): Promise<number> {
  return (await arrow(helperUnderTest())) + 1;
}
