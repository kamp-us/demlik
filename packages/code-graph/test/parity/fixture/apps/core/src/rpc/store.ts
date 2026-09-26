import { createProject as createProjectHandler, methodShaped, setupOnly } from "./handler";
export function create(input: object) { return createProjectHandler(input); }
export function viaMethod(input: object) { return methodShaped(input); }
export function viaEager(input: object) { return setupOnly(input); }
export function inner(input: object) {
  const local = () => create(input);
  const other = function named() { return viaMethod(input); };
  const socket = { onopen: () => viaEager(input), push: (x: number) => x };
  socket.onopen();
  socket.push(1);
  [1, 2].map((n) => n + 1).forEach((n) => local());
  return other();
}
