import { c } from "./two.js";

export function a(): number {
  return b() + 1;
}

export function b(): number {
  return c() * 2;
}
