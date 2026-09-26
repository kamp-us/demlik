import { z } from "zod";
import { DEFAULT_EXPORT, type EntryExportConventions } from "./conventions.js";

// A built-in set of entrypoint-export conventions for one framework. It activates on its own for
// a package whose package.json depends on `dependency`, and anywhere on an explicit opt-in.
export type EntryExportPreset = {
  readonly dependency: string;
  readonly conventions: EntryExportConventions;
};

const EXT = "{js,jsx,ts,tsx}";
const APP = "{,src/}app/**/";
const PAGES = "{,src/}pages/**/";
const ROOT = "{,src/}";

// Next.js, default `pageExtensions` only. The app router's special files, the pages router,
// and the root middleware (`proxy` since Next.js 16) and instrumentation files.
const NEXTJS: EntryExportPreset = {
  dependency: "next",
  conventions: {
    "nextjs/app-file": {
      files: `${APP}{page,layout,route,loading,error,global-error,not-found,template,default}.${EXT}`,
      exports: [DEFAULT_EXPORT],
    },
    "nextjs/app-metadata": {
      files: `${APP}{page,layout}.${EXT}`,
      exports: ["generateMetadata", "metadata", "generateViewport", "viewport"],
    },
    "nextjs/app-static-params": {
      files: `${APP}{page,layout,route}.${EXT}`,
      exports: ["generateStaticParams"],
    },
    "nextjs/app-segment-config": {
      files: `${APP}{page,layout,route}.${EXT}`,
      exports: [
        "dynamic",
        "dynamicParams",
        "revalidate",
        "fetchCache",
        "runtime",
        "preferredRegion",
        "maxDuration",
      ],
    },
    "nextjs/app-route-handler": {
      files: `${APP}route.${EXT}`,
      exports: ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"],
    },
    "nextjs/app-metadata-file": {
      files: `${APP}{opengraph-image,twitter-image,icon,apple-icon,sitemap,robots,manifest}.${EXT}`,
      exports: [DEFAULT_EXPORT, "generateImageMetadata", "generateSitemaps"],
    },
    "nextjs/pages": {
      files: `${PAGES}*.${EXT}`,
      exports: [DEFAULT_EXPORT, "getServerSideProps", "getStaticProps", "getStaticPaths", "config"],
    },
    "nextjs/middleware": {
      files: `${ROOT}{middleware,proxy}.${EXT}`,
      exports: ["middleware", "proxy", DEFAULT_EXPORT, "config"],
    },
    "nextjs/instrumentation": {
      files: `${ROOT}instrumentation.${EXT}`,
      exports: ["register", "onRequestError", DEFAULT_EXPORT, "config"],
    },
  },
};

export const ENTRY_EXPORT_PRESETS = { nextjs: NEXTJS } as const satisfies Record<
  string,
  EntryExportPreset
>;

export type EntryExportPresetName = keyof typeof ENTRY_EXPORT_PRESETS;

export const EntryExportPresetNameSchema = z.enum(
  Object.keys(ENTRY_EXPORT_PRESETS) as [EntryExportPresetName, ...EntryExportPresetName[]],
);

export const entryExportPresetNames = (): EntryExportPresetName[] =>
  EntryExportPresetNameSchema.options.slice();
