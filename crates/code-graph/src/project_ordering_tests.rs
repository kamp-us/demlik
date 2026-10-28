use super::*;
use crate::extract::wrangler_config::CatalogError;
use std::{
    cell::Cell,
    error::Error,
    sync::atomic::{AtomicU64, Ordering},
};

static NEXT: AtomicU64 = AtomicU64::new(0);
struct Fixture(PathBuf);
impl Fixture {
    fn new() -> Self {
        let root = std::env::temp_dir().join(format!(
            "demlik-project-ordering-native-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir_all(&root).unwrap();
        Self(root)
    }
    fn write(&self, file: &str, text: &str) {
        let path = self.0.join(file);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, text).unwrap();
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        fs::remove_dir_all(&self.0).unwrap();
    }
}
fn refuse<'a>(requests: &Cell<usize>) -> Result<&'a Collation, CollationError> {
    requests.set(requests.get() + 1);
    Err(CollationError::InputTooLong {
        units: 8,
        maximum: 7,
    })
}
#[test]
fn native_lazy_request_and_errors() {
    let fixture = Fixture::new();
    fixture.write("only.ts", "export const one=1;\n");
    fixture.write("README.md", "text");
    fixture.write("types.d.ts", "export {};\n");
    fixture.write("data.json", "{}");
    let requests = Cell::new(0);
    let empty = RepoListing {
        root: fixture.0.clone(),
        files: vec![],
    };
    let one = RepoListing {
        root: fixture.0.clone(),
        files: vec![
            "README.md".into(),
            "missing.ts".into(),
            "only.ts".into(),
            "types.d.ts".into(),
            "data.json".into(),
        ],
    };
    assert!(
        list_visible_files_request(&fixture.0, |_| true, Some(&empty), || refuse(&requests))
            .unwrap()
            .is_empty()
    );
    let loaded = load_cheap_project_request(&fixture.0, Some(&one), || refuse(&requests)).unwrap();
    assert_eq!(loaded.source_files.len(), 1);
    assert_eq!(
        requests.get(),
        0,
        "source filtering and stat precede sort cardinality"
    );
    let mut keep = Vec::new();
    let error = list_visible_files_request(
        &fixture.0,
        |file| {
            keep.push(file.to_owned());
            assert_eq!(
                requests.get(),
                0,
                "all keep/stat work precedes native preparation"
            );
            true
        },
        Some(&one),
        || refuse(&requests),
    )
    .unwrap_err();
    assert_eq!(keep, one.files);
    assert!(matches!(
        error,
        CollationError::InputTooLong {
            units: 8,
            maximum: 7
        }
    ));
    assert_eq!(
        requests.get(),
        1,
        "keep-all retains more than the later TS subset"
    );
    requests.set(0);
    let missing = JsString::from(format!("{}/unconfigured/", fixture.0.display()));
    let error =
        load_edge_project_text_request(&missing, EdgeScope::Package, &fixture.0, None, || {
            refuse(&requests)
        })
        .unwrap_err();
    let ProjectLoadError::MissingTsConfig(cause) = error else {
        panic!("configuration refusal must win")
    };
    assert!(cause.message().to_lossy().contains("unconfigured/"));
    assert_eq!(requests.get(), 0);
    fixture.write(
        "wrangler.json",
        r#"{"name":"invoice","vars":{"constructor":null}}"#,
    );
    let root: JsString = fixture.0.to_string_lossy().as_ref().into();
    let error =
        crate::env_keys::load_env_key_report(&root, &root, || refuse(&requests)).unwrap_err();
    assert!(matches!(
        error,
        crate::env_keys::EnvKeyError::Catalog(CatalogError::Record(_))
    ));
    assert_eq!(
        requests.get(),
        0,
        "one-source/one-config invalid record wins before a required sort"
    );
    fixture.write("second.ts", "export const two=2;\n");
    let error = load_cheap_project_request(&fixture.0, None, || refuse(&requests)).unwrap_err();
    let ProjectLoadError::Collation(ref original) = error else {
        panic!("infrastructure cause must remain typed")
    };
    let source = error
        .source()
        .unwrap()
        .downcast_ref::<CollationError>()
        .unwrap();
    assert!(std::ptr::eq(original, source));
    assert_eq!(requests.get(), 1);
    println!(
        "native-only: empty/single-source=0; keep-all=1; config/record first; original typed collation cause"
    );
}

struct Borrowed<'a> {
    name: &'a str,
    requests: &'a Rc<Cell<usize>>,
}
impl Borrowed<'_> {
    fn requested(self) {
        assert_eq!(self.name, "invoice");
        self.requests.set(self.requests.get() + 1);
    }
}
#[test]
fn native_original_owners_and_parser_cause() {
    let fixture = Fixture::new();
    fixture.write(
        "entry.ts",
        "declare const env:any; export function invoice(){ return env.Z+env.A; }\n",
    );
    fixture.write(
        "wrangler.json",
        r#"{"name":"invoice","vars":{"Z":"last","A":"first"}}"#,
    );
    let root: JsString = fixture.0.to_string_lossy().as_ref().into();
    let requests = Rc::new(Cell::new(0));
    let name = String::from("invoice");
    let observer = Borrowed {
        name: &name,
        requests: &requests,
    };
    let report = {
        let collation = Collation::try_node22_en_us().unwrap();
        let prepared = &collation;
        crate::env_keys::load_env_key_report(&root, &root, move || {
            observer.requested();
            Ok(prepared)
        })
    };
    // The report retains domain values, while its initializer borrowed a non-Clone/non-Send owner.
    let report = report.unwrap();
    assert_eq!(
        requests.get(),
        1,
        "load/catalog/scan/reconcile share one underlying request"
    );
    assert_eq!(report.declared_count, 2.0);
    let representation = serde_json::from_str::<serde_json::Value>("{").unwrap_err();
    let error = ProjectLoadError::Parse(ParseFailure::Representation(representation));
    let ProjectLoadError::Parse(ref original) = error else {
        unreachable!()
    };
    let source = error
        .source()
        .unwrap()
        .downcast_ref::<ParseFailure>()
        .unwrap();
    assert!(std::ptr::eq(original, source));
    assert!(matches!(source, ParseFailure::Representation(_)));
    println!(
        "native-only: original one-shot borrowed owner; report survives handle; precise synthetic parser representation cause"
    );
}
