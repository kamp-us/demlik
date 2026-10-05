# Changesets

This folder is the release ledger for every package under `packages/`. Each unreleased change
adds a markdown changeset here naming the packages it touches and the semver bump each one gets.

Add one with `pnpm changeset`. See https://github.com/changesets/changesets for the format.

To cut a release of one package, run this on a branch and open the result as a PR:

```sh
pnpm release:version <package>   # e.g. pnpm release:version @demlik/tea
```

It runs `changeset version` for that package alone. Every other package with a pending changeset
is passed to `--ignore`, along with each package that depends on one of them at runtime, so their
changesets stay in this folder for a later release. It prints each ignored package and why before
it runs. It refuses, and changes nothing, when the target has no pending changeset or shares a
changeset file with a package it has to hold back. For `@demlik/tea` it then regenerates
`packages/tea/docs/reference/`, which prints tea's version, so commit those pages with the bump.

When the version PR merges, the `publish` workflow (`.github/workflows/publish.yaml`) publishes
each package whose version is not on npm yet, via npm trusted publishing (OIDC). A package ends
`published`, `already published` or `failed`. `already published` is a green outcome: npm refused
the publish because a run a few minutes earlier had just published that version, and npm's
`dist.integrity` for it is the tarball this run packed. npm holding different bytes, or giving no
integrity within the read budget, is `failed`, and the job goes red.
