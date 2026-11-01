import { defineConfig } from "vitest/config";
import { reactPeerProjects } from "./packages/tea/react-peers/projects.ts";

// One run over every package, each under its own `vitest.config.ts`, so CI's
// JUnit report covers the whole workspace at once.
// `scripts` is the root's own tooling (publish-pending, #372), tested here so a
// release-path script is exercised on every PR rather than first on main.
// `reactPeerProjects` runs tea's React hook on each React its peer range allows.
export default defineConfig({
  test: {
    projects: [
      "packages/*",
      { test: { name: "scripts", include: ["scripts/**/*.test.mjs"] } },
      ...reactPeerProjects(),
    ],
  },
});
