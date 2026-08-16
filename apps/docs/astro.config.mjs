// @ts-check

import starlight from "@astrojs/starlight";
import { defineConfig } from "astro/config";
import starlightLinksValidator from "starlight-links-validator";

// Static Starlight site (prerender: true is the default) — no @astrojs/cloudflare
// adapter, no nodejs_compat. `astro build` emits a self-contained `dist/` that is
// served straight from Cloudflare Workers Assets (see wrangler.toml).
//
// Content is PROJECTED into src/content/docs/ by scripts/sync-content.mjs, which
// runs as prebuild/predev/pretypecheck. The canonical Markdown lives at the repo
// root (docs/, .patterns/, .decisions/) and is never edited by the site — read
// that script's header for why this is a projection and not symlinks.
export default defineConfig({
  site: "https://demlik.run",
  integrations: [
    starlight({
      title: "@demlik/tea",
      description:
        "The Elm Architecture as a TypeScript substrate — one pure reducer, every host adapter. Durable, replayable state machines for React, Cloudflare Durable Objects, Node, work queues and Chrome extensions.",
      // Link-integrity gate: fail the build on any internal link pointing at a
      // route that doesn't exist. This is what makes the sync script's link
      // rewriting trustworthy — a bad rewrite breaks the build instead of
      // shipping a 404.
      plugins: [starlightLinksValidator()],
      social: [
        {
          icon: "github",
          label: "GitHub",
          href: "https://github.com/kamp-us/demlik",
        },
      ],
      editLink: {
        baseUrl: "https://github.com/kamp-us/demlik/edit/main/",
      },
      // The four Diátaxis quadrants lead, because that is how the docs are
      // written. Canon and Decisions follow: they are the "why" surface, and
      // before this site existed they were readable only by cloning the repo.
      //
      // Each `directory` is relative to src/content/docs/ and matches a `dest`
      // in scripts/sync-content.mjs — a new tree is one row there plus one
      // group here.
      // Starlight removed the `{ label, autogenerate }` shorthand in 0.39, so every
      // group is a manual group whose `items` holds the autogenerate config.
      sidebar: [
        { label: "Tutorials", items: [{ autogenerate: { directory: "tutorial" } }] },
        { label: "How-to Guides", items: [{ autogenerate: { directory: "how-to" } }] },
        { label: "Reference", items: [{ autogenerate: { directory: "reference" } }] },
        { label: "Explanation", items: [{ autogenerate: { directory: "explanation" } }] },
        {
          label: "Canon",
          items: [
            { label: "TEA", items: [{ autogenerate: { directory: "patterns/tea" } }] },
            {
              label: "Durable actors",
              items: [{ autogenerate: { directory: "patterns/tea-do" } }],
            },
          ],
        },
        { label: "Decisions", items: [{ autogenerate: { directory: "decisions" } }] },
      ],
    }),
  ],
});
