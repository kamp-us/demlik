use demlik_code_graph::{
    boundaries::impure::{
        impure_bare_new_of, impure_module_of, impure_modules_opened, impure_path_of,
    },
    syntax::imports::{ImportEdge, ImportKind},
};
use indexmap::IndexSet;

#[test]
fn a_runtime_module_and_clock_read_share_the_boundary_vocabulary() {
    let path = ["process", "hrtime", "bigint"].map(Into::into);
    assert_eq!(impure_path_of(&path).unwrap(), "process.hrtime");
    assert!(impure_path_of(&["process".into()]).is_none());
    assert_eq!(impure_bare_new_of(&"Date".into()).unwrap(), "new Date()");
    let mut file = ImportEdge {
        specifier: "node:fs/promises".into(),
        kind: ImportKind::Static,
        type_only: false,
        target: None,
    };
    assert_eq!(impure_module_of(&file).unwrap(), "node:fs");
    let runtime = IndexSet::from([file.specifier.clone()]);
    assert_eq!(impure_modules_opened(&[file.clone()], &runtime).len(), 1);
    file.target = Some("src/fs.ts".into());
    assert!(impure_module_of(&file).is_none());
    file.target = None;
    file.type_only = true;
    assert!(impure_modules_opened(&[file], &runtime).is_empty());
}
