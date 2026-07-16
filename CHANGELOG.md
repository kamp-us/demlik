# @demlik/tea

## 0.1.1

### Patch Changes

- c470364: Ship the `./parity` subpath export to the registry. The export map already declares
  `@demlik/tea/parity` (built to `dist/parity`), but the published `0.1.0` predates it —
  so a cross-repo consumer installing the tarball hard-fails on `import "@demlik/tea/parity"`.
  This changeset bumps the package so trusted publishing republishes a version that actually
  carries the export.
