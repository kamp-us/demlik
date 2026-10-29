# Run a copied native CLI

Use an already-built `code-graph` executable for your operating system and architecture,
and an existing installation of `@typescript/native-preview` version
`7.0.0-dev.20260707.2`, including its matching platform package. The executable
does not install or download the compiler. Rust and Node are not needed to run it.

1. Copy the executable into its own directory. From a prepared native build:

   ```sh
   export CLI_STAGE="$HOME/tools/code-graph"
   mkdir -p "$CLI_STAGE"
   install -m 755 target/debug/code-graph "$CLI_STAGE/code-graph"
   ```

2. Reference the existing dependency installation from that directory:

   ```sh
   ln -s /absolute/path/to/existing/node_modules "$CLI_STAGE/node_modules"
   ```

   That dependency directory must make `@typescript/native-preview/package.json`
   resolvable and retain its matching platform package. Keep the referenced
   installation available when moving the CLI directory.

3. Run it from the project you want to inspect:

   ```sh
   unset DEMLIK_CODE_GRAPH_COMPILER_MANIFEST
   cd /path/to/client-project
   "$CLI_STAGE/code-graph" . --edges --graph --json
   "$CLI_STAGE/code-graph" . --plan --by complexity --json --out plan.json
   "$CLI_STAGE/code-graph" . --ci --fail-on warn
   ```

   A failing CI result exits with code 1. Fix the reported smells and repeat the
   same command to obtain a passing result.

4. To move the CLI, move its directory together with the `node_modules` reference,
   then use its new executable path. The compiler is resolved from the real
   executable's directory using Node package resolution. The client project's
   dependency directory is not a compiler fallback.

For local development or an explicitly selected existing dependency installation,
set the manifest override before running the executable or `cargo run`:

```sh
export DEMLIK_CODE_GRAPH_COMPILER_MANIFEST=/absolute/path/to/existing/node_modules/@typescript/native-preview/package.json
cargo run --locked -p demlik-code-graph --bin code-graph -- /path/to/client-project --edges --graph --json
```

The override takes precedence over installation discovery. An invalid override,
missing installation or wrong compiler version fails visibly; the CLI does not
search the client project or fall back to the builder checkout. Help and parser
errors still complete before compiler discovery. These steps do not create a
global installation or a package for another platform.
