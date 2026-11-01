// Reached from a production root, so it counts in reachableCount.
export function boot(): number {
  return start();
}

function start(): number {
  return 0;
}
