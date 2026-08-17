/**
 * Import a file from `examples/` from inside a test.
 *
 * The equivalence suites drive the REAL example machine against the chart port,
 * so they have to load `examples/*.ts` — and those files import `@demlik/tea`,
 * the published specifier. `vitest.config.ts` aliases that specifier to `src/`,
 * so the tests need no build; this wrapper exists for the case where the alias
 * is bypassed (running the file under plain `tsx`, say), where the failure is
 * otherwise a bare `ERR_MODULE_NOT_FOUND` naming a dist path nobody asked for.
 *
 * The specifier is passed as a VARIABLE on purpose: `examples/` compiles under
 * its own tsconfig, and a literal would pull it into this file's program.
 */
export async function importExample(specifier: string): Promise<unknown> {
  try {
    return await import(/* @vite-ignore */ specifier);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("@demlik/tea") || msg.includes("ERR_MODULE_NOT_FOUND")) {
      throw new Error(
        `cannot load "${specifier}": it imports "@demlik/tea", which resolves ` +
          `to dist/. Under vitest that specifier is aliased to src/ and no ` +
          `build is needed — outside vitest, run \`pnpm build\` first.\n\n` +
          `original error: ${msg}`,
      );
    }
    throw err;
  }
}
