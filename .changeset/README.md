# Changesets

This folder is the release ledger for `@demlik/tea`. Each unreleased change adds a
markdown changeset here declaring its semver bump; the `publish-tea` workflow consumes
them on merge to `main` (`changeset version`), bumps the package, then packs + publishes
the new version via npm trusted publishing (OIDC).

Add one with `pnpm changeset`. See https://github.com/changesets/changesets for the format.
