import { alpha } from "./a.js";
import { onlyTypeTested } from "./shape.js";

export function typeTest(): void {
  const width: number = onlyTypeTested("x");
  alpha(width);
}
