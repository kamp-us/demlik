use demlik_code_graph::{
    extract::assemble::{NodeFields, assemble_graph},
    hotspots::{ChurnData, ChurnWindow},
    project::{Collation, load_cheap_project},
    schema::Thresholds,
    text::JsString,
};
use std::{cell::Cell, error::Error, path::Path, rc::Rc};
struct Opaque<'a> {
    file: JsString,
    number: f64,
    borrowed: &'a str,
    local: Rc<()>,
}
struct NonCloneToken;
fn main() -> Result<(), Box<dyn Error>> {
    let root = std::env::args()
        .nth(1)
        .ok_or("real fixture repository required")?;
    let window = ChurnWindow {
        since_iso: "2019-12-31T00:00:00.000Z".into(),
        until_iso: "2020-02-01T00:00:00.000Z".into(),
        days: 32.,
    };
    let churn = demlik_code_graph::hotspots::load_churn_blocking(&root.as_str().into(), &window)?;
    let prepared = Collation::try_node22_en_us()?;
    let project = load_cheap_project(Path::new(&root), None, &prepared)?;
    let graph = assemble_graph(
        &project,
        Thresholds::default(),
        NodeFields::default(),
        &prepared,
    )?;
    let original_root = &graph.root;
    let canonical = demlik_code_graph::hotspots::compute_hotspots(&graph, &churn, &prepared)?;
    assert_eq!(canonical.len(), graph.modules.len());
    let rendered = demlik_code_graph::hotspots::render_hotspots(
        &graph, &churn, &window, 2., false, false, &prepared,
    )?;
    assert!(rendered.starts_with("Churn × complexity hotspots"));
    assert!(std::ptr::eq(original_root, &graph.root));
    let caller = String::from("caller borrowed data");
    let visits = Cell::new(0);
    let local = Rc::new(());
    let values = [
        Opaque {
            file: "z.ts".into(),
            number: 2.,
            borrowed: &caller,
            local: Rc::clone(&local),
        },
        Opaque {
            file: "a.ts".into(),
            number: 4.,
            borrowed: &caller,
            local: Rc::clone(&local),
        },
    ];
    let data = ChurnData {
        repo_root: "/authored".into(),
        head_sha: "head".into(),
        commits_by_file: [("z.ts".into(), 2.), ("a.ts".into(), 1.)]
            .into_iter()
            .collect(),
        tracked_files: ["z.ts".into(), "a.ts".into()].into_iter().collect(),
    };
    let token = NonCloneToken;
    let mut source = values.iter();
    let counter = &visits;
    let functions = std::iter::from_fn(move || {
        let _keep = &token;
        source.next().map(|value| {
            counter.set(counter.get() + 1);
            assert_eq!(value.borrowed, "caller borrowed data");
            assert_eq!(Rc::strong_count(&value.local), 3);
            (&value.file, value.number)
        })
    });
    let rows = demlik_code_graph::hotspots::compute_hotspots_from_parts(
        values.iter().map(|v| &v.file),
        functions,
        &data,
        &prepared,
    )?;
    assert_eq!(visits.get(), 2);
    assert_eq!(rows[0].file, "a.ts");
    drop(prepared);
    drop(values);
    drop(caller);
    let rendered = demlik_code_graph::hotspots::render_hotspot_rows(
        &rows,
        &data.head_sha,
        &window,
        0.,
        true,
        false,
    )?;
    assert!(rendered.contains(&"a.ts".into()));
    assert_eq!(Rc::strong_count(&local), 1);
    println!("borrowed canonical Graph + nonClone/nonSend borrowed iterator + owned rows: true");
    Ok(())
}
