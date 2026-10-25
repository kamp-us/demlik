use demlik_code_graph::{
    api::{
        emit::{CaptureFailure, DeclarationEmitFailure, emit_declarations},
        map::{ApiCallbackError, ApiError},
        model::SubpathNames,
        view::{PublishedApiOptions, read_published_api},
    },
    engine::tsgo::TsgoBinary,
    text::{JsString, JsValue},
};
use std::{
    cell::RefCell,
    error::Error,
    fs, io,
    path::{Path, PathBuf},
    rc::Rc,
    sync::{
        Arc,
        atomic::{AtomicU64, Ordering},
    },
};
fn compiler() -> TsgoBinary {
    TsgoBinary::from_native_preview_manifest(
        &Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../packages/code-graph/node_modules/@typescript/native-preview/package.json"),
    )
    .unwrap()
}
static NEXT: AtomicU64 = AtomicU64::new(0);
struct Package(PathBuf);
impl Package {
    fn new(source_file: &str, text: &str) -> Self {
        let root = loop {
            let root = std::env::temp_dir().join(format!(
                "demlik-api-view-native-{}-{}",
                std::process::id(),
                NEXT.fetch_add(1, Ordering::Relaxed)
            ));
            match fs::create_dir(&root) {
                Ok(()) => break root,
                Err(error) if error.kind() == io::ErrorKind::AlreadyExists => continue,
                Err(error) => panic!("create API package: {error}"),
            }
        };
        let package = Self(fs::canonicalize(root).unwrap());
        fs::create_dir(package.0.join("src")).unwrap();
        fs::write(package.0.join("tsconfig.json"), r#"{"compilerOptions":{"strict":true,"target":"ESNext","module":"ESNext","types":[]},"include":["src/**/*"]}"#).unwrap();
        fs::write(package.0.join("src").join(source_file), text).unwrap();
        package
    }
    fn root(&self) -> JsString {
        self.0.to_str().unwrap().into()
    }
}
impl Drop for Package {
    fn drop(&mut self) {
        if let Err(error) = fs::remove_dir_all(&self.0)
            && !std::thread::panicking()
        {
            panic!("remove API package: {error}");
        }
    }
}

#[test]
fn reads_the_real_four_entry_package_through_native_declarations_and_private_type_walk() {
    let package = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../packages/code-graph");
    let root = fs::canonicalize(package.join("test/api/fixture")).unwrap();
    let map = JsValue::parse(&fs::read_to_string(root.join("api-map.json")).unwrap()).unwrap();
    let compiler = TsgoBinary::from_native_preview_manifest(
        &package.join("node_modules/@typescript/native-preview/package.json"),
    )
    .unwrap();
    let mut warnings = Vec::new();
    let mut warn = |line: &JsString| {
        warnings.push(line.clone());
        Ok(())
    };
    let view = read_published_api(
        &root.to_str().unwrap().into(),
        &map,
        &compiler,
        PublishedApiOptions {
            repo_root: None,
            warn: Some(&mut warn),
        },
    )
    .unwrap();
    assert_eq!(view.subpaths.len(), 4);
    let names = &view.subpaths[&JsString::from(".")].names.entries;
    assert_eq!(names.len(), 4);
    let plain = &names[&JsString::from("plain")];
    assert_eq!(
        plain.text,
        "export declare function plain(n: number, step?: Step): number;"
    );
    assert_eq!(
        plain.references[&JsString::from("src/fns.d.ts#Step")],
        "type Step = {\n    readonly by: number;\n};"
    );
    let over = &names[&JsString::from("over")];
    assert_eq!(
        over.text,
        "export declare function over(a: string): string;\nexport declare function over(a: number): number;"
    );
    assert_eq!(view.compiler, compiler.version());
    assert!(warnings.is_empty());
}

#[test]
fn local_warning_callback_preserves_raw_failure_cause_and_removes_its_actual_emit() {
    let file = format!("owned-warning-{}.ts", std::process::id());
    let package = Package::new(&file, "export const ownedWarning: string = 1;");
    let map = JsValue::parse(&format!(r#"{{".":{{"entry":"src/{file}"}}}}"#)).unwrap();
    let warnings = Rc::new(RefCell::new(Vec::new()));
    let active_emits = Rc::new(RefCell::new(Vec::new()));
    let recorded = Rc::clone(&warnings);
    let captured_emits = Rc::clone(&active_emits);
    let expected = JsString::from_units("warning ".encode_utf16().chain([0xd800]).collect());
    let raw = expected.clone();
    let mut warn = |line: &JsString| {
        recorded.borrow_mut().push(line.clone());
        let declaration = format!("out/src/{}", file.replace(".ts", ".d.ts"));
        for entry in fs::read_dir(std::env::temp_dir()).unwrap() {
            let path = entry.unwrap().path();
            if path.join(&declaration).is_file() {
                captured_emits.borrow_mut().push(path);
            }
        }
        Err(ApiError::Callback(
            ApiCallbackError::new(raw.clone())
                .with_cause(fs::read(package.0.join("missing-warning-cause")).unwrap_err()),
        ))
    };
    let error = read_published_api(
        &package.root(),
        &map,
        &compiler(),
        PublishedApiOptions {
            repo_root: None,
            warn: Some(&mut warn),
        },
    )
    .unwrap_err();
    assert_eq!(warnings.borrow().len(), 1);
    assert_eq!(
        warnings.borrow()[0],
        "code-graph: warning: tsgo reported 1 diagnostic(s); the declarations were emitted anyway"
    );
    assert_eq!(error.message(), expected);
    assert_eq!(error.name(), "Error");
    assert!(!error.is_input());
    let cause = error
        .source()
        .unwrap()
        .downcast_ref::<ApiCallbackError>()
        .unwrap()
        .source()
        .unwrap()
        .downcast_ref::<io::Error>()
        .unwrap();
    assert_eq!(cause.kind(), io::ErrorKind::NotFound);
    assert_eq!(
        active_emits.borrow().len(),
        1,
        "observed the real emit before callback refusal"
    );
    assert!(active_emits.borrow().iter().all(|path| !path.exists()));
}

#[test]
fn native_reader_and_opaque_caller_keep_prototype_assignment_and_shared_fact_identity_distinct() {
    let package = Package::new(
        "index.ts",
        "const local = 1; export {local as \"__proto__\", local as a, local as b};",
    );
    let map = JsValue::parse(r#"{".":{"entry":"src/index.ts"}}"#).unwrap();
    let view = read_published_api(
        &package.root(),
        &map,
        &compiler(),
        PublishedApiOptions::default(),
    )
    .unwrap();
    let names = &view.subpaths[&JsString::from(".")].names;
    let prototype = names.prototype().unwrap();
    assert!(!names.entries.contains_key(&JsString::from("__proto__")));
    let a = &names.entries[&JsString::from("a")];
    let b = &names.entries[&JsString::from("b")];
    assert_eq!(prototype.text, "declare const local = 1;");
    assert_eq!(a.text, b.text);
    assert!(!Arc::ptr_eq(a, b));
    assert!(!Arc::ptr_eq(a, prototype));
    let opaque = [(JsString::from("__proto__"), Arc::clone(prototype))]
        .into_iter()
        .collect::<SubpathNames>();
    assert!(opaque.prototype().is_none());
    assert!(Arc::ptr_eq(
        &opaque.entries[&JsString::from("__proto__")],
        prototype
    ));
    assert_eq!(
        serde_json::to_string(&opaque).unwrap(),
        r#"{"__proto__":{"text":"declare const local = 1;","references":{}}}"#
    );
}

#[test]
fn compiler_limit_failure_retains_the_real_raw_capture_and_native_status() {
    let source = (0..16000)
        .map(|i| format!("export const n{i}: string = 1;\n"))
        .collect::<String>();
    let package = Package::new("index.ts", &source);
    let config = package.0.join("tsconfig.json");
    let error = emit_declarations(
        &package.root(),
        &config.to_str().unwrap().into(),
        &compiler(),
    )
    .unwrap_err();
    assert_eq!(error.name(), "ApiInputError");
    assert!(error.message().to_lossy().ends_with(" ENOBUFS"));
    let failure = error
        .source()
        .unwrap()
        .downcast_ref::<demlik_code_graph::api::map::ApiInputError>()
        .unwrap()
        .source()
        .unwrap()
        .downcast_ref::<DeclarationEmitFailure>()
        .unwrap();
    let CaptureFailure::OutputLimit { limit, captured } = failure.failures().first().unwrap()
    else {
        panic!("expected measured buffer refusal")
    };
    assert_eq!(*limit, 1_048_576);
    assert!(*captured > 1_048_576);
    assert_eq!(*captured, failure.stdout().len() + failure.stderr().len());
    assert!(
        String::from_utf8_lossy(failure.stdout()).starts_with("src/index.ts(1,14): error TS2322:")
    );
    assert!(failure.status().is_some());
}

#[test]
fn private_import_type_reference_uses_the_semantic_kind_despite_reverse_enum_alias() {
    let package = Package::new(
        "index.ts",
        "export type Imported = import('./hidden').Hidden;",
    );
    fs::write(
        package.0.join("src/hidden.ts"),
        "export interface Hidden { readonly private: string }",
    )
    .unwrap();
    let map = JsValue::parse(r#"{".":{"entry":"src/index.ts"}}"#).unwrap();
    let view = read_published_api(
        &package.root(),
        &map,
        &compiler(),
        PublishedApiOptions::default(),
    )
    .unwrap();
    let references =
        &view.subpaths[&JsString::from(".")].names.entries[&JsString::from("Imported")].references;
    assert_eq!(references.len(), 1);
    assert_eq!(
        references[&JsString::from("src/hidden.d.ts#Hidden")],
        "export interface Hidden {\n    readonly private: string;\n}"
    );
}

#[test]
fn raw_emitted_entry_reaches_the_actual_go_source_file_refusal() {
    let package = Package::new("raw�.ts", "export declare function raw():void;");
    let map = JsValue::parse(r#"{".":{"entry":"src/raw\ud800.ts"}}"#).unwrap();
    let error = read_published_api(
        &package.root(),
        &map,
        &compiler(),
        PublishedApiOptions::default(),
    )
    .unwrap_err();
    let ApiError::Compiler(demlik_code_graph::engine::tsgo::TsgoError::Compiler {
        method,
        message,
    }) = error
    else {
        panic!("expected actual Go refusal")
    };
    assert_eq!(method, "getSourceFile");
    assert!(message.contains("invalid surrogate pair"));
    assert!(message.contains("\\ud800.d.ts"));
    assert!(message.contains("\"/file\""));
}

#[test]
fn text_program_roots_and_cache_keep_raw_lookup_distinct_from_the_replacement_file() {
    use demlik_code_graph::engine::tsgo::{TextProgramInput, TsgoError, open_type_session_text};
    let package = Package::new("raw�.d.ts", "export declare const raw:1;");
    let config: JsString = package.0.join("tsconfig.json").to_str().unwrap().into();
    let physical: JsString = package.0.join("src/raw�.d.ts").to_str().unwrap().into();
    let raw = JsString::from_units(
        physical
            .units()
            .iter()
            .map(|unit| if *unit == 0xfffd { 0xd800 } else { *unit })
            .collect(),
    );
    let mut session = open_type_session_text(&compiler(), &config).unwrap();
    for (roots, literal_expected) in [
        (vec![raw.clone()], false),
        (vec![physical.clone(), raw.clone()], true),
        (vec![physical.clone()], true),
    ] {
        session
            .with_compilation_text(
                TextProgramInput {
                    root_files: &roots,
                    include_config_files: false,
                },
                |program| {
                    assert_eq!(
                        program.source_file_text(&physical)?.is_some(),
                        literal_expected
                    );
                    let error = match program.source_file_text(&raw) {
                        Err(error) => error,
                        Ok(_) => panic!("raw lookup must reach Go"),
                    };
                    let TsgoError::Compiler { method, message } = error else {
                        panic!("expected actual Go refusal")
                    };
                    assert_eq!(method, "getSourceFile");
                    assert!(message.contains("invalid surrogate pair"));
                    Ok(())
                },
            )
            .unwrap();
    }
}

#[test]
fn text_roots_sort_by_utf16_before_go_merges_global_declarations() {
    use demlik_code_graph::engine::tsgo::{TextProgramInput, open_type_session_text};
    let package = Package::new("entry.d.ts", "export type Published=Shared;");
    let bmp = package.0.join("src/\u{e000}.d.ts");
    let astral = package.0.join("src/\u{10000}.d.ts");
    fs::write(&bmp, "interface Shared {bmp:1}").unwrap();
    fs::write(&astral, "interface Shared {astral:1}").unwrap();
    let entry: JsString = package.0.join("src/entry.d.ts").to_str().unwrap().into();
    let config: JsString = package.0.join("tsconfig.json").to_str().unwrap().into();
    let roots = vec![
        JsString::from(bmp.to_str().unwrap()),
        JsString::from(astral.to_str().unwrap()),
        entry.clone(),
        JsString::from(astral.to_str().unwrap()),
    ];
    let mut session = open_type_session_text(&compiler(), &config).unwrap();
    session
        .with_compilation_text(
            TextProgramInput {
                root_files: &roots,
                include_config_files: false,
            },
            |program| {
                let source = program.source_file_text(&entry)?.unwrap();
                let reference = source
                    .root()
                    .descendants()?
                    .into_iter()
                    .find(|node| node.is_kind("TypeReference"))
                    .unwrap()
                    .node("typeName")?
                    .unwrap();
                let symbol = program.symbol_at(&reference)?.unwrap();
                let names = program
                    .declarations(&symbol)?
                    .iter()
                    .map(|node| {
                        node.file_name()
                            .file_name()
                            .unwrap()
                            .to_str()
                            .unwrap()
                            .to_owned()
                    })
                    .collect::<Vec<_>>();
                assert_eq!(names, vec!["\u{10000}.d.ts", "\u{e000}.d.ts"]);
                Ok(())
            },
        )
        .unwrap();
}
