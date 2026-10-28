use demlik_code_graph::extract::wrangler_config::{find_wrangler_configs, load_binding_catalog};
use std::{
    fs,
    time::{SystemTime, UNIX_EPOCH},
};

#[test]
fn reads_real_wrangler_groups_legacy_dates_and_dev_vars_with_observable_unparsed_files() {
    let project_collation = demlik_code_graph::project::Collation::try_node22_en_us().unwrap();
    let unique = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let root = std::env::temp_dir().join(format!("demlik-catalog-{}-{unique}", std::process::id()));
    for (file, source) in [
        (
            "services/a/wrangler.jsonc",
            "\u{feff}// api\n{\"name\":\"api\",\"main\":\"./src/main.ts\",\"services\":[{\"binding\":\"SEARCH\",\"service\":\"worker\"}],\"durable_objects\":{\"bindings\":[{\"name\":\"ROOM\",\"class_name\":\"Room\"}]},\"workflows\":[{\"binding\":\"FLOW\",\"class_name\":\"Flow\"}],\"d1_databases\":[{\"binding\":\"DB\"}],\"vars\":{\"Z\":1},\"secrets\":{\"required\":[\"A\",\"Z\"]},\"unknown\":{\"binding\":\"UNLISTED\"},\"env\":{\"test\":{\"binding\":\"IGNORED\"}},}",
        ),
        (
            "services/a/.dev.vars",
            "# local\n LOCAL = one\n\u{feff}BOM=two\n\u{85}KEY=three\nexport EXPORTED=four\n",
        ),
        ("services/a/.dev.vars.example", "EXAMPLE=one\nLOCAL=two\n"),
        (
            "services/b/wrangler.toml",
            "name = 'worker'\nmain = 'index.ts'\nlegacy = 2024-02-30\n[[services]]\nbinding = 'API'\nservice = 'api'\n",
        ),
        (
            "services/bad/wrangler.json",
            "{\"name\":\"broken\",\"services\":[{",
        ),
        (
            "services/unsafe/wrangler.toml",
            "name = 'unsafe'\nignored = 9007199254740992\n",
        ),
        (
            "services/leap/wrangler.toml",
            "name = 'leap'\nignored = 23:59:60\n",
        ),
    ] {
        let path = root.join(file);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, source).unwrap();
    }
    assert_eq!(
        find_wrangler_configs(&root, None, &project_collation)
            .unwrap()
            .len(),
        5
    );
    let catalog = load_binding_catalog(&root, None, &project_collation).unwrap();
    assert_eq!(catalog.manifests.len(), 2);
    assert_eq!(
        catalog.unparsed_configs,
        [
            "services/bad/wrangler.json",
            "services/leap/wrangler.toml",
            "services/unsafe/wrangler.toml"
        ]
    );
    let api = &catalog.manifests[0];
    assert_eq!(api.service, "api");
    assert_eq!(api.main.as_ref().unwrap(), "services/a/src/main.ts");
    assert_eq!(api.bindings.len(), 3);
    assert_eq!(api.data_bindings.len(), 2);
    assert_eq!(api.env_keys, ["A", "Z"]);
    assert_eq!(api.binding_names, ["DB", "FLOW", "SEARCH", "UNLISTED"]);
    assert!(api.dev_vars_keys.iter().any(|key| key == "\u{85}KEY"));
    assert!(api.dev_vars_keys.iter().any(|key| key == "BOM"));
    assert!(api.dev_vars_keys.iter().any(|key| key == "export EXPORTED"));
    assert_eq!(api.dev_vars_files, [".dev.vars", ".dev.vars.example"]);
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn preserves_jsonc_assignment_prototypes_and_keeps_toml_properties_own() {
    let unique = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let root = std::env::temp_dir().join(format!(
        "demlik-catalog-proto-{}-{unique}",
        std::process::id()
    ));
    for (file, text) in [
        (
            "inherited/wrangler.jsonc",
            r#"{"__proto__":{"name":"inherited","services":[{"binding":"B","service":"remote"}]},"vars":{"__proto__":null,"__proto__":{"binding":"OWN"},"X":1}}"#,
        ),
        (
            "toml-own/wrangler.toml",
            "[__proto__]\nname='inherited'\n[vars]\n__proto__={binding='OWN'}\nX=1\n",
        ),
        (
            "array-proto/wrangler.jsonc",
            r#"{"vars":{"__proto__":[],"X":1}}"#,
        ),
        (
            "throwing/wrangler.jsonc",
            r#"{"name":2,"vars":{"__proto__":{"constructor":null}}}"#,
        ),
        ("raw/wrangler.json", r#"{"main":"./\ud800.ts"}"#),
        ("erased/wrangler.json", r#"{"main":"\ud800/../actual.ts"}"#),
    ] {
        let path = root.join(file);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, text).unwrap();
    }
    let inherited = load_binding_catalog(
        &root.join("inherited"),
        None,
        &demlik_code_graph::project::Collation::try_node22_en_us().unwrap(),
    )
    .unwrap()
    .manifests
    .remove(0);
    assert_eq!(inherited.service, "inherited");
    assert_eq!(inherited.bindings[0].binding, "B");
    assert_eq!(inherited.env_keys, ["X"]);
    assert_eq!(inherited.binding_names, ["OWN"]);
    let own = load_binding_catalog(
        &root.join("toml-own"),
        None,
        &demlik_code_graph::project::Collation::try_node22_en_us().unwrap(),
    )
    .unwrap()
    .manifests
    .remove(0);
    assert_eq!(own.service, "toml-own");
    assert!(own.bindings.is_empty());
    assert_eq!(own.env_keys, ["X"]);
    assert_eq!(own.binding_names, ["OWN"]);
    assert!(
        load_binding_catalog(
            &root.join("array-proto"),
            None,
            &demlik_code_graph::project::Collation::try_node22_en_us().unwrap()
        )
        .unwrap()
        .manifests[0]
            .env_keys
            .is_empty()
    );
    let error = load_binding_catalog(
        &root.join("throwing"),
        None,
        &demlik_code_graph::project::Collation::try_node22_en_us().unwrap(),
    )
    .unwrap_err();
    assert!(matches!(
        error,
        demlik_code_graph::extract::wrangler_config::CatalogError::Record(_)
    ));
    assert_eq!(
        error.to_string(),
        "Cannot read properties of null (reading 'prototype')"
    );
    let raw = load_binding_catalog(
        &root.join("raw"),
        None,
        &demlik_code_graph::project::Collation::try_node22_en_us().unwrap(),
    )
    .unwrap()
    .manifests
    .remove(0)
    .main
    .unwrap();
    assert!(raw.to_utf8().is_err());
    assert_eq!(raw.units(), [0xd800, 46, 116, 115]);
    assert_eq!(
        load_binding_catalog(
            &root.join("erased"),
            None,
            &demlik_code_graph::project::Collation::try_node22_en_us().unwrap()
        )
        .unwrap()
        .manifests[0]
            .main
            .as_ref()
            .unwrap(),
        "actual.ts"
    );
    fs::remove_dir_all(root).unwrap();
}
