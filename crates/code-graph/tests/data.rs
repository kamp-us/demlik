use demlik_code_graph::{
    data::{access::access_of, extract::binding_sites},
    engine::oxc::parse_type_script,
    schema::{DataAccess, DataBindingKind},
    text::JsString,
};
use indexmap::IndexMap;
use std::{fs, path::Path};

#[test]
fn finds_each_handlers_own_binding_and_classifies_its_literal_sql() {
    struct Binding {
        name: JsString,
        kind: DataBindingKind,
    }
    let file = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../packages/code-graph/test/data/alias-scope/workers/app/src/handlers.ts");
    let text = fs::read_to_string(&file).unwrap();
    let syntax = parse_type_script(&file, &text).unwrap();
    let bindings: IndexMap<_, _> = ["DB", "OTHER"]
        .into_iter()
        .map(|name| {
            (
                JsString::from(name),
                Binding {
                    name: name.into(),
                    kind: DataBindingKind::D1,
                },
            )
        })
        .collect();
    let sites = binding_sites(&syntax, &bindings);
    assert_eq!(
        sites
            .iter()
            .map(|site| (site.line, site.decl.name.to_utf8().unwrap()))
            .collect::<Vec<_>>(),
        [
            (11, "DB"),
            (15, "OTHER"),
            (23, "DB"),
            (27, "OTHER"),
            (39, "DB"),
            (46, "DB"),
            (51, "DB"),
            (59, "DB"),
            (71, "DB")
        ]
        .into_iter()
        .map(|(line, name)| (line, name.to_owned()))
        .collect::<Vec<_>>()
    );
    assert!(sites.iter().all(|site| {
        site.method
            .as_ref()
            .is_some_and(|method| method == "prepare")
    }));
    assert!(sites.iter().all(|site| matches!(
        access_of(site.decl.kind, site.method.as_ref(), site.sql.as_ref()),
        DataAccess::Read
    )));
}
