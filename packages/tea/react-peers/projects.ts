import { readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

const here = (path: string): string =>
  fileURLToPath(new URL(`./${path}`, import.meta.url));

/**
 * One vitest project per folder here. Each runs `peer-range.test.tsx` with that
 * folder's `react` and `react-dom` in place of the dev pin, because the dev pin
 * cannot show what the rest of the published peer range does.
 *
 * Each React is its own package, not a pnpm alias in tea's manifest: `react-dom`
 * takes `react` as a peer, so an alias there would load it against the dev pin's
 * `react`.
 */
export const reactPeerProjects = () =>
  readdirSync(here("."), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map(({ name: version }) => ({
      root: here(".."),
      resolve: {
        alias: [
          {
            find: /^(react|react-dom)(\/.*)?$/,
            replacement: `${here(version)}/node_modules/$1$2`,
          },
        ],
      },
      test: {
        name: `tea on react ${version}`,
        include: ["src/react/peer-range.test.tsx"],
        env: { TEA_REACT_PEER: version },
      },
    }));
