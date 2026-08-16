import { docsLoader } from "@astrojs/starlight/loaders";
import { docsSchema } from "@astrojs/starlight/schema";
import { defineCollection } from "astro:content";

// The `docs` collection Starlight's injected [...slug] route renders.
// docsLoader() globs the FIXED path src/content/docs/, which is a PROJECTION of
// the repo's canonical Markdown produced by scripts/sync-content.mjs (run as
// prebuild/predev/pretypecheck). Everything under it except index.mdx is
// generated and gitignored; the canonical sources are docs/, .patterns/ and
// .decisions/ at the repo root.
export const collections = {
  docs: defineCollection({ loader: docsLoader(), schema: docsSchema() }),
};
