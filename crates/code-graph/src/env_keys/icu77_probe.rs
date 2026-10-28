//! Private-owner paired fixture. It is never a public env-key API or executable alias.
use super::*;
use crate::{
    engine::oxc::parse_type_script,
    env_keys::{extract::EnvKeyScan, render::render_env_keys},
    extract::wrangler_config::load_binding_catalog,
    project::SourceUnit,
    text::{JsObject, JsValue},
};
use serde::Deserialize;
use std::{
    error::Error,
    fs,
    path::{Path, PathBuf},
    rc::Rc,
};

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Unit {
    #[serde(default)]
    alias: Option<usize>,
    #[serde(default)]
    file: String,
    #[serde(default)]
    text: String,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Request {
    id: String,
    mode: String,
    directory: PathBuf,
    units: Vec<Unit>,
    candidates: Vec<JsString>,
}
fn object<const N: usize>(pairs: [(&str, JsValue); N]) -> JsValue {
    JsValue::Object(
        pairs
            .into_iter()
            .map(|(k, v)| (k.into(), v))
            .collect::<JsObject>(),
    )
}
fn serialized(value: &impl serde::Serialize) -> JsValue {
    JsValue::parse(&serde_json::to_string(value).unwrap()).unwrap()
}
fn report_view(report: &EnvKeyReport) -> JsValue {
    object([
        ("report", serialized(report)),
        (
            "text",
            JsValue::String(render_env_keys(report, false, false).unwrap()),
        ),
        (
            "json",
            JsValue::String(render_env_keys(report, true, false).unwrap()),
        ),
        (
            "pretty",
            JsValue::String(render_env_keys(report, true, true).unwrap()),
        ),
    ])
}
fn scan_view(scan: &EnvKeyScan) -> JsValue {
    let reads: Vec<_> = scan
        .reads
        .iter()
        .map(|r| {
            object([
                ("name", JsValue::String(r.name.clone())),
                ("file", JsValue::String(r.file.clone())),
                ("line", JsValue::Number(r.line as f64)),
                ("via", JsValue::String(r.via.as_str().into())),
            ])
        })
        .collect();
    object([
        ("reads", JsValue::Array(reads)),
        (
            "occursIn",
            JsValue::Array(
                scan.occurs_in
                    .iter()
                    .map(|(key, files)| {
                        JsValue::Array(vec![JsValue::String(key.clone()), serialized(files)])
                    })
                    .collect(),
            ),
        ),
    ])
}
macro_rules! observe {
    ($calls:expr, $function:path $(, $arg:expr)* $(,)?) => {{
        let result = $function($($arg),*);
        $calls.push(stringify!($function));
        result
    }};
}
#[test]
#[ignore = "paired Source/native fixture supplies request and response paths"]
fn paired() -> Result<(), Box<dyn Error>> {
    let input = std::env::var_os("DEMLIK_ENV_KEYS_REQUEST").ok_or("request file required")?;
    let output = std::env::var_os("DEMLIK_ENV_KEYS_RESPONSE").ok_or("response file required")?;
    let request: Request = serde_json::from_slice(&fs::read(input)?)?;
    let mut calls = Vec::new();
    let result = (|| -> Result<JsValue, Box<dyn Error>> {
        if request.mode == "load" {
            let collation = Collation::try_node22_en_us()?;
            let root = JsString::from(request.directory.to_str().ok_or("UTF8 fixture root")?);
            let report = observe!(
                &mut calls,
                crate::env_keys::query::load_env_key_report,
                &root,
                &root,
                || Ok(&collation)
            )?;
            return Ok(report_view(&report));
        }
        let mut units: Vec<Rc<SourceUnit>> = Vec::new();
        for unit in &request.units {
            if let Some(alias) = unit.alias {
                units.push(Rc::clone(
                    units.get(alias).ok_or("earlier source alias required")?,
                ));
            } else {
                let absolute = request.directory.join(&unit.file);
                units.push(Rc::new(SourceUnit {
                    syntax: parse_type_script(&absolute, &unit.text)?,
                    absolute_path: absolute,
                    file: unit.file.clone(),
                }));
            }
        }
        let before: Vec<_> = units.iter().map(Rc::as_ptr).collect();
        let groups: Vec<Vec<_>> = units
            .iter()
            .map(|unit| {
                units
                    .iter()
                    .enumerate()
                    .filter_map(|(i, other)| Rc::ptr_eq(unit, other).then_some(i))
                    .collect()
            })
            .collect();
        let collation = Collation::try_node22_en_us()?;
        let catalog = if request.mode == "query" {
            Some(observe!(
                &mut calls,
                crate::extract::wrangler_config::load_binding_catalog,
                &request.directory,
                None,
                &collation
            )?)
        } else if request.mode == "scan" {
            None
        } else {
            return Err("unknown fixture mode".into());
        };
        let candidates = if let Some(catalog) = &catalog {
            catalog
                .manifests
                .iter()
                .flat_map(|m| m.env_keys.iter().chain(&m.dev_vars_keys))
                .cloned()
                .collect()
        } else {
            request.candidates.iter().cloned().collect()
        };
        let scan = observe!(
            &mut calls,
            crate::env_keys::extract::scan_env_keys,
            &units,
            &candidates,
            &mut || Ok(&collation)
        )?;
        let unchanged = before
            .iter()
            .zip(&units)
            .all(|(before, after)| *before == Rc::as_ptr(after));
        assert!(unchanged);
        let scan_output = scan_view(&scan);
        let identity = object([
            ("groups", serialized(&groups)),
            ("unchanged", JsValue::Bool(unchanged)),
        ]);
        if let Some(catalog) = catalog {
            let report = observe!(
                &mut calls,
                crate::env_keys::query::find_env_key_mismatches,
                catalog,
                scan,
                &mut || Ok(&collation)
            )?;
            Ok(object([
                ("scan", scan_output),
                ("identity", identity),
                ("report", report_view(&report)),
            ]))
        } else {
            Ok(object([("scan", scan_output), ("identity", identity)]))
        }
    })();
    let response = match result {
        Ok(value) => object([
            ("id", JsValue::String(request.id.into())),
            ("ok", JsValue::Bool(true)),
            ("output", value),
            ("observedCalls", serialized(&calls)),
        ]),
        Err(error) => {
            let (name, message) = if let Some(error) = error.downcast_ref::<EnvKeyError>() {
                (error.name(), error.message())
            } else if let Some(error) =
                error.downcast_ref::<crate::extract::wrangler_config::CatalogError>()
            {
                (error.name(), error.message())
            } else {
                ("Error", error.to_string().into())
            };
            object([
                ("id", JsValue::String(request.id.into())),
                ("ok", JsValue::Bool(false)),
                (
                    "error",
                    object([
                        ("name", JsValue::String(name.into())),
                        ("message", JsValue::String(message)),
                    ]),
                ),
                ("observedCalls", serialized(&calls)),
            ])
        }
    };
    fs::write(output, serde_json::to_string(&response)?)?;
    Ok(())
}

struct Workspace(PathBuf);
impl Workspace {
    fn new() -> Self {
        use std::sync::atomic::{AtomicU64, Ordering};
        static NEXT: AtomicU64 = AtomicU64::new(0);
        let root = std::env::temp_dir().join(format!(
            "demlik-env-request-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir(&root).unwrap();
        let workspace = Self(fs::canonicalize(root).unwrap());
        workspace.put("pnpm-workspace.yaml", "packages: []\n");
        workspace
    }
    fn put(&self, file: &str, text: &str) {
        let file = self.0.join(file);
        fs::create_dir_all(file.parent().unwrap()).unwrap();
        fs::write(file, text).unwrap();
    }
    fn text(&self) -> JsString {
        self.0.to_str().unwrap().into()
    }
}
impl Drop for Workspace {
    fn drop(&mut self) {
        fs::remove_dir_all(&self.0).unwrap();
    }
}

#[test]
fn empty_and_singleton_facts_do_not_request_collation() -> Result<(), Box<dyn Error>> {
    for text in ["export const note = 1;", "export const read = env.ONLY;"] {
        let unit = Rc::new(SourceUnit {
            syntax: parse_type_script(Path::new("only.ts"), text)?,
            absolute_path: "only.ts".into(),
            file: "only.ts".into(),
        });
        let original = Rc::as_ptr(&unit);
        let mut request = || panic!("a zero/one-row sort must remain lazy");
        let scan = scan_env_keys(std::slice::from_ref(&unit), &IndexSet::new(), &mut request)?;
        let report = find_env_key_mismatches(
            BindingCatalog {
                manifests: vec![],
                unparsed_configs: vec![],
            },
            scan,
            &mut request,
        )?;
        assert_eq!(Rc::as_ptr(&unit), original);
        assert!(report.withheld.len() <= 1);
    }
    Ok(())
}

#[test]
fn catalog_refusal_precedes_initialization_after_source_parse_failure() {
    let workspace = Workspace::new();
    workspace.put("src/index.ts", "export const = ;");
    workspace.put(
        "wrangler.jsonc",
        r#"{"name":"bad","vars":{"constructor":null}}"#,
    );
    let root = workspace.text();
    let error = load_env_key_report(&root, &root, || {
        panic!("catalog refusal precedes initialization")
    })
    .unwrap_err();
    assert!(matches!(error, EnvKeyError::Catalog(_)));
    assert_eq!(error.name(), "TypeError");
    assert_eq!(
        error.message(),
        "Cannot read properties of null (reading 'prototype')"
    );
}

#[test]
fn one_borrowed_request_serves_catalog_scan_and_query_then_results_outlive_handle()
-> Result<(), Box<dyn Error>> {
    let workspace = Workspace::new();
    workspace.put("src/index.ts", "export const read = [env.C, env.D];");
    workspace.put(
        "wrangler.jsonc",
        r#"{"name":"worker","vars":{"z":"x","A":"x","b":"x"}}"#,
    );
    let root = workspace.text();
    let calls = std::cell::Cell::new(0);
    let report = {
        let collation = Collation::try_node22_en_us()?;
        load_env_key_report(&root, &root, || {
            calls.set(calls.get() + 1);
            workspace.put("src/index.ts", "export const note = 1;");
            Ok(&collation)
        })?
    };
    assert_eq!(calls.get(), 1);
    assert_eq!(report.declared_count, 3.0);
    assert_eq!(report.read_count, 2.0);
    assert_eq!(
        report
            .declared_unreferenced
            .iter()
            .map(|row| row.key.to_lossy())
            .collect::<Vec<_>>(),
        ["A", "b", "z"]
    );
    assert_eq!(
        report
            .read_not_declared
            .iter()
            .map(|row| row.key.to_lossy())
            .collect::<Vec<_>>(),
        ["C", "D"]
    );
    Ok(())
}

#[test]
fn scan_initialization_failure_keeps_its_typed_original_source() {
    let workspace = Workspace::new();
    workspace.put("src/index.ts", "export const read = [env.B, env.A];");
    let root = workspace.text();
    let error = load_env_key_report(&root, &root, || {
        // The real ICU wrapper refuses an embedded NUL before its native call.
        Err(CollationError::Initialize(
            rust_icu_ucol::UCollator::try_from("en\0US").unwrap_err(),
        ))
    })
    .unwrap_err();
    let EnvKeyError::Collation(ref collation) = error else {
        panic!("lost direct scan error: {error:?}")
    };
    assert!(std::ptr::eq(
        error
            .source()
            .unwrap()
            .downcast_ref::<CollationError>()
            .unwrap(),
        collation
    ));
    let CollationError::Initialize(source) = collation else {
        panic!("lost initializer cause")
    };
    assert!(std::ptr::eq(
        collation
            .source()
            .unwrap()
            .downcast_ref::<rust_icu_common::Error>()
            .unwrap(),
        source
    ));
    assert_eq!(error.name(), "Error");
    assert_eq!(error.message(), JsString::from(collation.to_string()));
}
