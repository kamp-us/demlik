The prepared collation module uses checksum-pinned ICU 77.1 source/data and the
safe rust_icu 5.8.0 family. This first migration covers the unreachable ledger;
other collation call sites still use the legacy backend. There is no fallback
from a migrated operation to that backend.

Collation and the prepared CLI continuation that retains it stay on their
owning thread. They do not promise Send or Sync. Ledger results do not retain
that handle or its lifetime; caller data/callbacks gain no new blanket bounds.
An async host must run a complete blocking CLI operation on one selected thread
rather than moving this continuation between workers.

Local builds currently support aarch64 macOS only. Python 3.12 or later, Apple's
clang/clang++, make, and the Rust toolchain are required. Other hosts and release
packages remain unverified. Native work, binding versions, data hashes, build
flags, linked archives, and license inputs are recorded under the owning root
workspace's default `target/icu77/`. Preparation refuses external target aliases
and a second native attempt in the same check tree. It never installs system
libraries, downloads at runtime, or copies compiled caches.

Supply the verified source archive identified in `tools/icu77/inputs.json` before
building. In the registered check worktree, with all four target aliases unset:

```sh
export DEMLIK_ICU77_PYTHON=/absolute/path/to/python3
export DEMLIK_ICU77_PREPARED="$PWD/target/icu77/prepared.json"
export RUST_ICU_MAJOR_VERSION_NUMBER=77
export RUST_ICU_LINK_SEARCH_DIR="$PWD/target/icu77/install/lib"
"$DEMLIK_ICU77_PYTHON" tools/icu77/prepare.py prepare \
  --host aarch64-apple-darwin --target aarch64-apple-darwin \
  --source-archive /absolute/path/to/icu4c-77_1-src.tgz
cargo test --locked --offline -p demlik-code-graph
```

These exports belong only to that build invocation/check tree. The native
subprocess environment is explicitly scrubbed. The code-graph build script
verifies the stamp and actual static archives before accepting the package;
the safe sys static feature links the complete data archive. Missing preparation
is an actionable build failure, not permission to select system ICU.

This is a build-scoped source/data contract. It is not a safe runtime version
getter or a guarantee of whole-data identity with Node. In particular, the
earlier icuinfo resource query was partial/failed despite exit0 and does not
establish live CLDR/tz versions. Comparison inputs preserve raw UTF16 units and
have an explicit native limit of i32::MAX units. Very large native inputs and
ordinary allocation exhaustion are not universal Source-parity claims.
