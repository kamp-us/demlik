import { readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

const here = (path: string): string =>
  fileURLToPath(new URL(`./${path}`, import.meta.url));

/**
 * One vitest project per folder here. Each runs `src/pbt`'s tests with that
 * folder's `fast-check` in place of the dev pin, because the dev pin cannot show
 * what the rest of the published peer range does. Each folder also has a
 * `typecheck` script, which `pnpm typecheck` picks up.
 */
export const fastCheckPeerProjects = () =>
  readdirSync(here("."), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map(({ name: version }) => ({
      root: here(".."),
      resolve: {
        alias: [
          {
            find: /^fast-check$/,
            replacement: `${here(version)}/node_modules/fast-check`,
          },
        ],
      },
      test: {
        name: `tea pbt on fast-check ${version}`,
        include: ["src/pbt/**/*.test.ts"],
        setupFiles: ["./src/test-setup.ts"],
        env: { TEA_FAST_CHECK_PEER: version },
      },
    }));
