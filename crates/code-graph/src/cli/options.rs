use crate::text::JsString;
use indexmap::IndexMap;
use serde::{Serialize, Serializer, ser::SerializeMap};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum OptionSource {
    Default,
    Cli,
}
#[derive(Debug, Serialize)]
#[serde(untagged)]
pub enum OptionValue {
    Flag(bool),
    Text(JsString),
    Texts(Vec<JsString>),
}
#[derive(Debug)]
struct Setting {
    value: OptionValue,
    source: OptionSource,
}
#[derive(Debug)]
pub struct CliOptions {
    values: IndexMap<OptionId, Setting>,
}
impl Serialize for CliOptions {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        let mut map = serializer.serialize_map(Some(self.values.len()))?;
        for (id, setting) in &self.values {
            map.serialize_entry(id.key(), &setting.value)?;
        }
        map.end()
    }
}
impl CliOptions {
    pub(crate) fn new() -> Self {
        let mut options = Self {
            values: IndexMap::new(),
        };
        for spec in OPTION_SPECS {
            let value = match spec.default {
                DefaultValue::None => continue,
                DefaultValue::Text(text) => OptionValue::Text(text.into()),
                DefaultValue::EmptyList => OptionValue::Texts(Vec::new()),
            };
            options.values.insert(
                spec.id,
                Setting {
                    value,
                    source: OptionSource::Default,
                },
            );
        }
        options
    }
    pub fn value(&self, id: OptionId) -> Option<&OptionValue> {
        self.values.get(&id).map(|setting| &setting.value)
    }
    pub fn source(&self, id: OptionId) -> Option<OptionSource> {
        self.values.get(&id).map(|setting| setting.source)
    }
    pub fn keys(&self) -> impl Iterator<Item = OptionId> + '_ {
        self.values.keys().copied()
    }
    pub fn given(&self) -> impl Iterator<Item = OptionId> + '_ {
        self.values
            .iter()
            .filter_map(|(id, setting)| (setting.source == OptionSource::Cli).then_some(*id))
    }
    pub(crate) fn set(&mut self, id: OptionId, value: OptionValue) {
        self.values.insert(
            id,
            Setting {
                value,
                source: OptionSource::Cli,
            },
        );
    }
    pub(crate) fn apply(&mut self, id: OptionId, value: Option<JsString>) {
        if id.spec().kind == ValueKind::Repeat {
            let setting = self.values.get_mut(&id).expect("repeat default is present");
            let OptionValue::Texts(values) = &mut setting.value else {
                unreachable!("repeat option has list value")
            };
            values.push(value.expect("required repeat value was consumed"));
            setting.source = OptionSource::Cli;
            return;
        }
        let value = match id.spec().kind {
            ValueKind::Flag => OptionValue::Flag(true),
            ValueKind::Text => {
                OptionValue::Text(value.expect("required option value was consumed"))
            }
            ValueKind::Repeat => unreachable!("repeat handled above"),
        };
        self.set(id, value);
    }
}
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ValueKind {
    Flag,
    Text,
    Repeat,
}
#[derive(Debug, Clone, Copy)]
pub enum DefaultValue {
    None,
    Text(&'static str),
    EmptyList,
}
#[derive(Debug, Clone, Copy)]
pub enum Description {
    Literal(&'static str),
    EntryPresets,
}
impl Description {
    pub fn text(self) -> String {
        match self {
            Self::Literal(text) => text.into(),
            Self::EntryPresets => format!(
                "turn on a built-in entrypoint-export preset ({}) even where the package does not depend on its framework; repeatable",
                crate::kinds::presets::entry_export_preset_names()
                    .iter()
                    .map(|name| name.as_str())
                    .collect::<Vec<_>>()
                    .join(" | ")
            ),
        }
    }
}
#[derive(Debug)]
pub struct OptionSpec {
    pub id: OptionId,
    pub key: &'static str,
    pub flags: &'static str,
    pub kind: ValueKind,
    pub default: DefaultValue,
    pub description: Description,
}
impl OptionSpec {
    pub fn long(&self) -> &'static str {
        self.flags
            .split(' ')
            .next()
            .expect("option flag has a long name")
    }
}
macro_rules! option_getter {
    (Flag, $getter:ident, $id:ident) => {
        pub fn $getter(&self) -> Option<bool> {
            self.value(OptionId::$id).map(|value| match value {
                OptionValue::Flag(value) => *value,
                _ => unreachable!("flag has boolean value"),
            })
        }
    };
    (Text, $getter:ident, $id:ident) => {
        pub fn $getter(&self) -> Option<&JsString> {
            self.value(OptionId::$id).map(|value| match value {
                OptionValue::Text(value) => value,
                _ => unreachable!("text option has text value"),
            })
        }
    };
    (Repeat, $getter:ident, $id:ident) => {
        pub fn $getter(&self) -> &[JsString] {
            match self
                .value(OptionId::$id)
                .expect("repeat default is present")
            {
                OptionValue::Texts(values) => values,
                _ => unreachable!("repeat option has list value"),
            }
        }
    };
}
macro_rules! option_table {
    ($(
        $id:ident, $getter:ident, $key:literal, $flags:literal,
        $kind:ident, $default:expr, $description:expr;
    )*) => {
        #[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize)]
        pub enum OptionId {
            $(#[serde(rename = $key)] $id,)*
        }
        pub static OPTION_SPECS: &[OptionSpec] = &[
            $(OptionSpec {
                id: OptionId::$id,
                key: $key,
                flags: $flags,
                kind: ValueKind::$kind,
                default: $default,
                description: $description,
            },)*
        ];
        impl OptionId {
            pub fn spec(self) -> &'static OptionSpec {
                &OPTION_SPECS[self as usize]
            }
            pub fn key(self) -> &'static str {
                self.spec().key
            }
        }
        impl CliOptions {
            $(option_getter!($kind, $getter, $id);)*
        }
    };
}
option_table! {
    Graph, graph, "graph", "--graph", Flag, DefaultValue::None, Description::Literal("emit the full Graph JSON (the large dump)");
    Plan, plan, "plan", "--plan", Flag, DefaultValue::None, Description::Literal("emit ranked refactor targets (human table; --json for PlanRow[])");
    By, by, "by", "--by <axis>", Text, DefaultValue::Text("rot"), Description::Literal("plan ranking axis: rot | impact | complexity | size");
    Smells, smells, "smells", "--smells", Flag, DefaultValue::None, Description::Literal("emit all smells grouped by kind (human; --json for Smell[])");
    Tree, tree, "tree", "--tree", Flag, DefaultValue::None, Description::Literal("emit an indented file → function tree with inline smell markers");
    Hexagon, hexagon, "hexagon", "--hexagon", Flag, DefaultValue::None, Description::Literal("emit one feature's Ports & Adapters (human; --json for data)");
    File, file, "file", "--file <f>", Text, DefaultValue::None, Description::Literal("emit one module + its functions");
    Edges, edges, "edges", "--edges", Flag, DefaultValue::None, Description::Literal("run the opt-in edge pass (calls/calledBy/importedBy/chain + edge smells)");
    Headers, headers, "headers", "--headers", Flag, DefaultValue::None, Description::Literal(concat!(
            "give each function node a `header`: its declaration header as written, from where its startLine places it",
            " (export and modifiers included) to the last token before its body (an arrow's ends on =>), no leading ",
            "comment, plus its overload signatures with their start lines (overloads are never nodes); absent without ",
            "the flag"
        ));
    Deep, deep, "deep", "--deep", Flag, DefaultValue::None, Description::Literal("edge pass over the whole monorepo (cross-package callers; implies --edges)");
    Blast, blast, "blast", "--blast <id>", Text, DefaultValue::None, Description::Literal("callers of <id> (direct + transitive); requires the edge pass");
    Find, find, "find", "--find <name>", Text, DefaultValue::None, Description::Literal(concat!(
            "every function and top-level declaration (type alias, interface, enum, class, constant) named <name>, as ",
            "JSON: kind, file, line, exported flag and uses; implies the edge pass"
        ));
    Html, html, "html", "--html", Flag, DefaultValue::None, Description::Literal("emit a self-contained HTML report (human view); implies the edge pass");
    Ci, ci, "ci", "--ci", Flag, DefaultValue::None, Description::Literal(concat!(
            "CI gate: exit non-zero per --fail-on / --max policy; when smell-ledger.json at the repo root names rules ",
            "in its \"gated\" list, gates those rules' smells against its entries instead (--fail-on and --max are ",
            "ignored, and smells of other rules neither fail nor are recorded): fails on a smell of a gated rule the ",
            "ledger does not name, at any severity, or on a recorded one whose value grew, and writes back entries ",
            "whose smell shrank (value lowered) or is gone (pruned); an edge-pass rule gated turns the edge pass on"
        ));
    FailOn, fail_on, "failOn", "--fail-on <level>", Text, DefaultValue::Text("high"), Description::Literal("CI severity to fail on: high | warn");
    Max, max, "max", "--max <n>", Text, DefaultValue::None, Description::Literal("CI: fail if total smell count exceeds <n>");
    AcceptSmells, accept_smells, "acceptSmells", "--accept-smells", Flag, DefaultValue::None, Description::Literal(concat!(
            "record today's smells of the rules smell-ledger.json gates: add every one the ledger does not name ",
            "(entries keyed by rule and repo-relative target), raise each recorded one that grew to its measured ",
            "value, each carrying --reason \"<why>\" (required), and lower and prune as --ci does; exits 2 when no rule ",
            "is gated; not with --ci"
        ));
    Thresholds, thresholds, "thresholds", "--thresholds <file>", Text, DefaultValue::None, Description::Literal("JSON file of partial threshold overrides merged over defaults");
    CrossRuntime, cross_runtime, "crossRuntime", "--cross-runtime", Flag, DefaultValue::None, Description::Literal("resolve env.<BINDING>.<method>() to the target worker (implies edges)");
    Kinds, kinds, "kinds", "--kinds", Flag, DefaultValue::None, Description::Literal("classify each node entry|effect|auth|plain (implies --cross-runtime)");
    Unreachable, unreachable, "unreachable", "--unreachable", Flag, DefaultValue::None, Description::Literal(concat!(
            "exported symbols with no path from any entry (implies --kinds); with --ci, gates them against ",
            "unreachable-ledger.json at the repo root instead of gating smells: fails on a finding (dead or ",
            "only-called-from-tests) the ledger does not name for this scope, and prunes this scope's entries whose ",
            "finding is gone"
        ));
    AcceptDead, accept_dead, "acceptDead", "--accept-dead", Flag, DefaultValue::None, Description::Literal(concat!(
            "with --unreachable: add every finding unreachable-ledger.json does not name yet for this scope (entries ",
            "keyed by scope, kind and id), each carrying --reason \"<why>\" (required); not with --ci"
        ));
    DeadOnly, dead_only, "deadOnly", "--dead-only", Flag, DefaultValue::None, Description::Literal(concat!(
            "with --unreachable --ci: gate only `dead` findings; an `only-called-from-tests` finding neither fails the",
            " run nor is pruned from the ledger"
        ));
    Unguarded, unguarded, "unguarded", "--unguarded", Flag, DefaultValue::None, Description::Literal("effect nodes reachable from an entry with no auth on the path");
    Clusters, clusters, "clusters", "--clusters", Flag, DefaultValue::None, Description::Literal("communities vs directories: where the layout lies (implies --cross-runtime)");
    InterfaceWidth, interface_width, "interfaceWidth", "--interface-width", Flag, DefaultValue::None, Description::Literal("exports per package + external (outside-package) consumer counts; implies the edge pass");
    Data, data, "data", "--data", Flag, DefaultValue::None, Description::Literal("data edges: which function reads or writes which D1 / Durable Object / KV / R2 / queue binding");
    Cycles, cycles, "cycles", "--cycles", Flag, DefaultValue::None, Description::Literal("module-import cycles, reported as participating files (implies --edges)");
    NodeKinds, node_kinds, "nodeKinds", "--node-kinds <file>", Text, DefaultValue::None, Description::Literal("JSON file of node-kind rule overrides merged over defaults");
    EntryPreset, entry_preset, "entryPreset", "--entry-preset <name>", Repeat, DefaultValue::EmptyList, Description::EntryPresets;
    Layers, layers, "layers", "--layers", Flag, DefaultValue::None, Description::Literal("layer gate: every import edge pointing UP the declared layer stack");
    LayerRules, layer_rules, "layerRules", "--layer-rules <file>", Text, DefaultValue::None, Description::Literal("JSON file declaring the layer stack and allowlist (required by --layers)");
    Boundaries, boundaries, "boundaries", "--boundaries", Flag, DefaultValue::None, Description::Literal(concat!(
            "feature boundaries: cross-feature imports not through <feature>/index.ts (B1), lib/ importing a feature ",
            "(B3), a file in no feature importing a feature's internals (B4); a scope that declares features in ",
            "--boundary-rules lays its features out as index.ts, ports.ts, application/, adapters/driving/ and ",
            "adapters/driven/ (or, when it lists all three of application, driving-adapters and driven-adapters, as ",
            "one hexagon with those folders straight under src/ and its ports in application/driving-ports/ and ",
            "application/driven-ports/; a scope lists one layout, never both, and never only some of the three), and ",
            "judges application/ importing its own adapters/ (B6 application-imports-adapter), a file touching the ",
            "outside world in index.ts, ports.ts, application/ or adapters/driving/ through any process.<member> ",
            "(process.env, process.hrtime, process.platform, …), fetch, the clock or a module such as node:fs (B7 ",
            "impure; a type-only import of node:fs or node:child_process opens nothing), adapters/driving/ importing ",
            "its own application/ or adapters/driven/ (B8 driving-reaches-driven) and a feature entry no zone names ",
            "(B10 unknown-zone); libraries the rules file declares (libraryTypes, libraries, libraryRoots, ",
            "worldLibraries, allowImportNames of --boundary-rules) are judged between packages: a package under a ",
            "library root no library names (B11 library-undeclared), a library importing a library whose type its own ",
            "type does not list, unless allowImportNames (importer, then imported library, then names) licenses every ",
            "name the file takes from it (B12 library-imports-up), a pure library touching the outside world or ",
            "importing a world library (B7 impure) and a library imported from outside the zones its type names (B14 ",
            "adapter-library-imported-outside-driven), with a census of the libraries; the shape of a hexagonal ",
            "feature's own files, for the kinds the applicationShape key lists and none run until listed: an entry ",
            "file (a library's src/index.ts, a feature's index.ts) that holds more than named re-exports (B15 ",
            "index-not-exports-only) and an application/ import outside its allowlist of its own ports.ts and ",
            "application/, another feature's index.ts, lib, a library whose type applicationMayImport lists and a ",
            "pureDependencies package (B16 application-import-outside-allowlist), where testFiles, matched against a ",
            "file's scope-relative and its repo-relative path, takes a test file out of the zones (B6-B8, B10, B15, ",
            "B16 and B17 stop judging it), compositionRoots (globs of the files that assemble the whole app, matched ",
            "the same way, with testFiles listed) turns on B20 test-reaches-composition-root, which reports a test ",
            "file that opens, when it runs, a file from which a composition root is reached (one entry per file the ",
            "test opens that is in reach, named for the first file on the way to a root; a test is a driving adapter ",
            "on one application's ports in Cockburn's hexagon, and a composition root is the one place the wiring ",
            "happens in Seemann's; a deliberate test of the wiring is accepted by name with --accept-crossings ",
            "--reason), readAllowance lets a driving adapter import a listed driven file that holds no data write ",
            "beside a library of a decidedBy type, or with no such import when the entry leaves decidedBy out (B8); ",
            "across deployables, the kinds the acrossDeployables key of --boundary-rules lists are judged, and none ",
            "run until listed: a worker binding its owning worker declares used outside a hexagonal feature's ",
            "adapters/driven/ (driven-adapters/ in the port layout) and outside that worker's wrangler main, which ",
            "wires its own bindings (B17 binding-outside-driven-adapter), workers that bind each other in a loop (B18 ",
            "worker-call-cycle, scope \".\", measured only by a run at the repo root) and a relative import into another",
            " workspace (B19 relative-import-crosses-workspace), with a census of the worker bindings read (gateable ",
            "via --ci against boundary-ledger.json: fails on a crossing the ledger does not name, prunes entries whose",
            " crossing is gone)"
        ));
    AcceptCrossings, accept_crossings, "acceptCrossings", "--accept-crossings", Flag, DefaultValue::None, Description::Literal(concat!(
            "with --boundaries: add every crossing boundary-ledger.json does not name yet, each carrying --reason ",
            "\"<why>\" (required)"
        ));
    Reason, reason, "reason", "--reason <text>", Text, DefaultValue::None, Description::Literal(concat!(
            "with --boundaries --accept-crossings: why these crossings stay; with --unreachable --accept-dead: why ",
            "these unreachable exports stay; with --accept-smells: why these smells stay"
        ));
    MigrateCeilings, migrate_ceilings, "migrateCeilings", "--migrate-ceilings", Flag, DefaultValue::None, Description::Literal(concat!(
            "with --boundaries: seed boundary-ledger.json from today's crossings (impure uses, library crossings B11, ",
            "B12 and B14, shape crossings B15-B16, deployable crossings B17-B19 and test crossings B20 included) and ",
            "delete boundary-ceilings.json; refuses if any scope's import crossings exceed its recorded count ",
            "(library, shape, deployable and test crossings are not counted)"
        ));
    BoundaryRules, boundary_rules, "boundaryRules", "--boundary-rules <file>", Text, DefaultValue::None, Description::Literal(concat!(
            "JSON file of boundary-declaration overrides (features per scope, lib; libraryTypes: each library type, ",
            "the types it imports, whether it is pure and where it may be imported from; libraries: package directory ",
            "to type; libraryRoots: directories whose every package must be declared; worldLibraries: package globs a ",
            "pure library may not import; acrossDeployables: the deployable rules to run, any of ",
            "binding-outside-driven-adapter, worker-call-cycle and relative-import-crosses-workspace, none by default;",
            " bindingOwners: per scope, each worker binding and the scope-relative driven-adapter files that may use ",
            "it, besides the main of the worker; applicationShape: the shape rules to run, any of ",
            "index-not-exports-only and application-import-outside-allowlist, none by default; applicationMayImport: ",
            "library types an application/ file may import, none by default; pureDependencies: package globs an ",
            "application/ file may import; testFiles: globs of test files, each matched against the scope-relative and",
            " the repo-relative path of a file, which sit in no zone; compositionRoots: globs of the files that ",
            "assemble the whole app, matched the same way, which a test may not open when it runs, directly or through",
            " other files (B20 test-reaches-composition-root; none by default, and it needs testFiles); readAllowance:",
            " per scope, driven files a driving adapter may import and, optionally, the decidedBy library types that ",
            "make it so; left out, a listed file that only reads is licensed for any driving file) merged over ",
            "defaults"
        ));
    Collapse, collapse, "collapse", "--collapse", Flag, DefaultValue::None, Description::Literal(concat!(
            "collapse candidates (a report) + partial twins: a shared decision prologue over the same named constants,",
            " diverging afterwards (gateable via --ci). Implies --kinds"
        ));
    CollapseConfig, collapse_config, "collapseConfig", "--collapse-config <file>", Text, DefaultValue::None, Description::Literal("JSON file of collapse-setting overrides merged over defaults");
    Hotspots, hotspots, "hotspots", "--hotspots", Flag, DefaultValue::None, Description::Literal("churn x complexity hotspots (git log joined with complexity)");
    HotspotsDays, hotspots_days, "hotspotsDays", "--hotspots-days <n>", Text, DefaultValue::Text("90"), Description::Literal("hotspots window in days");
    HotspotsSince, hotspots_since, "hotspotsSince", "--hotspots-since <iso>", Text, DefaultValue::None, Description::Literal("window start ISO date (overrides --hotspots-days)");
    HotspotsLimit, hotspots_limit, "hotspotsLimit", "--hotspots-limit <n>", Text, DefaultValue::Text("20"), Description::Literal("hotspots top-N (--json emits all rows)");
    EnvKeys, env_keys, "envKeys", "--env-keys", Flag, DefaultValue::None, Description::Literal("env-var keys declared (wrangler vars/secrets, .dev.vars) but never read, and vice versa");
    Comments, comments, "comments", "--comments", Flag, DefaultValue::None, Description::Literal("comment census: comment lines per bucket and class (mechanical / protected / prose), by scope and by file");
    WriteCeilings, write_ceilings, "writeCeilings", "--write-ceilings", Flag, DefaultValue::None, Description::Literal(concat!(
            "with --comments: rewrite comment-ceilings.json; with --collapse: record this scope's partial-twin count ",
            "in collapse-ceilings.json. Not for --boundaries, whose crossings live one per entry in ",
            "boundary-ledger.json: use --accept-crossings --reason, or --migrate-ceilings once from ",
            "boundary-ceilings.json"
        ));
    Api, api, "api", "--api <map>", Text, DefaultValue::None, Description::Literal(concat!(
            "published-API view (SPEC §13): emit <path>'s declarations with the pinned tsgo into a temp folder and ",
            "print, per export subpath of the JSON map <map> ({ \"<subpath>\": { \"entry\": \"<source file>\", \"tier\"?: ",
            "\"<string>\" } }), every published name with its declaration text and the text of the unpublished ",
            "declarations it references; combines only with --api-base, --api-policy, --json, --pretty and --out"
        ));
    ApiPolicy, api_policy, "apiPolicy", "--api-policy <file>", Text, DefaultValue::None, Description::Literal(concat!(
            "with --api --api-base: gate the diff on the package's changesets (SPEC §13.5). <file> is the caller's ",
            "JSON bump policy ({ \"callout\": \"<marker>\", \"tiers\": { \"<tier>\": { \"added\" | \"changed\" | \"removed\": { ",
            "\"bump\": \"none\" | \"patch\" | \"minor\" | \"major\", \"callout\"?: true } } }, \"default\"?: <one tier's row> }); ",
            "code-graph ships no policy of its own. The changesets that count are the .changeset/*.md files added ",
            "since <rev> whose frontmatter names the package of <path>/package.json; the highest of their bumps is ",
            "compared with the bump each changed name's tier and change kind needs, and a rule with a callout also ",
            "needs the marker in a counted changeset's body. Prints one line on a pass, or one block per name that ",
            "misses (name, subpath, tier, change kind, bump needed and found, before/after text); --json prints the ",
            "verdict. Exits 0 on a pass, 1 on a miss, 2 on a tier with no policy row and no default"
        ));
    ApiBase, api_base, "apiBase", "--api-base <rev>", Text, DefaultValue::None, Description::Literal(concat!(
            "with --api: diff the published API against the commit <rev> names (SPEC §13.4) and print, per subpath, ",
            "the added, removed and changed names with before/after text and tier; the base tree is read from git's ",
            "objects into a temp folder, never into the checkout"
        ));
    Pretty, pretty, "pretty", "--pretty", Flag, DefaultValue::None, Description::Literal("pretty-print JSON output");
    Json, json, "json", "--json", Flag, DefaultValue::None, Description::Literal("force JSON output on a view command");
    Out, out, "out", "--out <file>", Text, DefaultValue::None, Description::Literal("write the view output to <file> directly (banner-safe); default is stdout");
}
