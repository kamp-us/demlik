use crate::{
    api::{
        emit::{EmitGuard, emit_declarations, emitted_entries},
        map::{ApiError, ApiInputError, ApiSubpath, api_subpaths},
        model::{EmittedNames, PublishedApi, PublishedSubpath, SubpathNames},
        read::read_subpath_names_text,
    },
    engine::tsgo::{TextProgramInput, TsgoBinary, open_type_session_text},
    project::{EdgeScope, find_repo_root, resolve_edge_ts_config_text},
    text::{JsString, JsValue},
};
use std::{io::Write, path::Path};

pub type ApiWarning<'a> = dyn FnMut(&JsString) -> Result<(), ApiError> + 'a;
#[derive(Default)]
pub struct PublishedApiOptions<'a> {
    pub repo_root: Option<&'a JsString>,
    pub warn: Option<&'a mut ApiWarning<'a>>,
}
pub use super::root::{package_root, project_relative};
pub fn read_emitted_names(
    root: &JsString,
    subpaths: &[ApiSubpath],
    compiler: &TsgoBinary,
    mut options: PublishedApiOptions<'_>,
    context: Option<&JsString>,
) -> Result<EmittedNames, ApiError> {
    let native_root = root.to_lossy();
    let repo_root = options.repo_root.cloned().unwrap_or_else(|| {
        find_repo_root(Path::new(&native_root))
            .to_string_lossy()
            .as_ref()
            .into()
    });
    let config =
        resolve_edge_ts_config_text(root, EdgeScope::Package, Path::new(&repo_root.to_lossy()))
            .map_err(|error| {
                ApiError::Input(ApiInputError::new(error.message().clone()).with_cause(error))
            })?;
    let emit = EmitGuard::new(emit_declarations(root, &config, compiler)?);
    let result = (|| {
        if emit.get().diagnostics > 0.0 {
            let mut message = JsString::from(format!(
                "code-graph: warning: tsgo reported {} diagnostic(s)",
                crate::render::text::number(emit.get().diagnostics)
            ));
            if let Some(context) = context {
                message.extend(context);
            }
            message.push_str("; the declarations were emitted anyway");
            if let Some(warn) = options.warn.as_mut() {
                warn(&message)?;
            } else {
                let mut bytes = message.to_lossy().into_bytes();
                bytes.push(b'\n');
                std::io::stderr()
                    .lock()
                    .write_all(&bytes)
                    .map_err(|source| ApiError::Io {
                        path: "stderr".into(),
                        source,
                    })?;
            }
        }
        let entries = emitted_entries(emit.get(), root, subpaths)?;
        let roots = entries.values().cloned().collect::<Vec<_>>();
        let mut session = open_type_session_text(compiler, &config).map_err(ApiError::Compiler)?;
        let names = session
            .with_compilation_text(
                TextProgramInput {
                    root_files: &roots,
                    include_config_files: false,
                },
                |program| {
                    entries
                        .into_iter()
                        .map(|(subpath, file)| {
                            Ok((
                                subpath,
                                read_subpath_names_text(program, &emit.get().out, &file)?,
                            ))
                        })
                        .collect()
                },
            )
            .map_err(ApiError::Compiler)?;
        Ok(EmittedNames {
            compiler: emit.get().compiler.clone(),
            names,
        })
    })();
    emit.finish(result)
}
pub fn read_published_api(
    root: &JsString,
    map: &JsValue,
    compiler: &TsgoBinary,
    options: PublishedApiOptions<'_>,
) -> Result<PublishedApi, ApiError> {
    let absolute = package_root(root)?;
    let subpaths = api_subpaths(&absolute, map)?;
    let emitted = read_emitted_names(&absolute, &subpaths, compiler, options, None)?;
    let mut names = emitted.names;
    let subpaths = subpaths
        .into_iter()
        .map(|part| {
            let found = names
                .shift_remove(&part.subpath)
                .unwrap_or_else(SubpathNames::default);
            (
                part.subpath,
                PublishedSubpath {
                    entry: part.entry,
                    tier: part.tier,
                    names: found,
                },
            )
        })
        .collect();
    Ok(PublishedApi {
        root: project_relative(&absolute)?,
        compiler: emitted.compiler,
        subpaths,
    })
}
