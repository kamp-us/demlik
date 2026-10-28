use demlik_code_graph::{
    extract::assemble::{NodeFields, assemble_graph},
    project::{Collation, list_repo, list_visible_files, load_cheap_project},
    schema::Thresholds,
};
use std::{cell::Cell, error::Error, path::Path, rc::Rc};

struct Observer<'a> {
    label: &'a str,
    visits: Rc<Cell<usize>>,
}

fn main() -> Result<(), Box<dyn Error>> {
    let arguments: Vec<_> = std::env::args().collect();
    let root = Path::new(&arguments[1]);
    let label = String::from("borrowed project predicate");
    let observer = Observer {
        label: &label,
        visits: Rc::new(Cell::new(0)),
    };
    let listing = list_repo(root);
    let owner = listing.files.as_ptr();
    let before = serde_json::to_vec(&listing.files)?;
    let (files, loaded, first, graph) = {
        let collation = Collation::try_node22_en_us()?;
        let files = list_visible_files(
            root,
            |file| {
                assert!(!observer.label.is_empty());
                observer.visits.set(observer.visits.get() + 1);
                !file.is_empty()
            },
            Some(&listing),
            &collation,
        )?;
        let loaded = load_cheap_project(root, Some(&listing), &collation)?;
        let first = Rc::clone(&loaded.source_files[0]);
        let graph = assemble_graph(
            &loaded,
            Thresholds::default(),
            NodeFields::default(),
            &collation,
        )?;
        (files, loaded, first, graph)
    };
    assert!(observer.visits.get() > 0);
    assert!(!files.is_empty());
    assert_eq!(listing.files.as_ptr(), owner);
    assert_eq!(serde_json::to_vec(&listing.files)?, before);
    assert!(Rc::ptr_eq(&first, &loaded.source_files[0]));
    assert!(!first.syntax.text().is_empty());
    assert!(!graph.functions.is_empty());
    println!(
        "borrowed non-Clone/non-Debug/non-Send predicate; original listing/Rc syntax and owned results after Collation drop"
    );
    Ok(())
}
