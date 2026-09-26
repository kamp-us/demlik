---
"@demlik/code-graph": minor
---

`--kinds` and `--unreachable` learn entrypoint-export conventions, with a built-in Next.js
preset (#468).

An entrypoint-export convention is a file glob, relative to the package that owns the file,
plus the export names that count as entries in files it matches (`default` names the default
export whatever its local name). A matched export classifies as `entry` with the convention's
name as its evidence and roots the reachability walk, so it no longer lands in `--unreachable`
as `dead`; an export the convention does not list is judged as before.

The `nextjs` preset covers the app router under `app/**` and `src/app/**` (special-file default
exports, metadata, `generateStaticParams`, route segment config, route handlers), the pages
router under `pages/**` and `src/pages/**`, and the root `middleware` / `proxy` and
`instrumentation` files. It activates for a package that lists `next` in `dependencies` or
`devDependencies`, and anywhere on `--entry-preset nextjs` or `"entryExportPresets": ["nextjs"]`
in the `--node-kinds` file. Your own conventions go under `entryExportConventions` in that file
and add to the active presets rather than replacing them.
