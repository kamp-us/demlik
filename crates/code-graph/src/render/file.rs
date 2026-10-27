use super::{ReportRenderError, json::stable_stringify};
use crate::{
    project::{relative_path_text_from, resolve_path_text_from},
    schema::Graph,
    text::JsString,
};
use serde::Serialize;
pub struct FileRender {
    pub stdout: Option<JsString>,
    pub warning: Option<JsString>,
}
pub fn render_file(
    graph: &Graph,
    root_absolute: &JsString,
    target: &JsString,
    pretty: bool,
) -> Result<FileRender, ReportRenderError> {
    let absolute = resolve_path_text_from(&JsString::default(), target)?;
    let wanted = relative_path_text_from(root_absolute, &absolute)?;
    let matches = |file: &str| wanted == file || target == file;
    let warning = |suffix: &str| {
        let mut line = JsString::from("warning: ");
        line.extend(&wanted);
        line.push_str(suffix);
        FileRender {
            stdout: None,
            warning: Some(line),
        }
    };
    if graph
        .summary
        .parse_failures
        .iter()
        .any(|file| matches(file))
    {
        return Ok(warning(" failed to parse and was excluded from the graph."));
    }
    let Some(module) = graph.modules.iter().find(|module| matches(&module.file)) else {
        return Ok(warning(" is not in the analyzed graph (no such module)."));
    };
    #[derive(Serialize)]
    struct Payload<'a> {
        provenance: &'a crate::schema::Provenance,
        module: &'a crate::schema::ModuleNode,
        functions: Vec<&'a crate::schema::FunctionNode>,
    }
    let payload = Payload {
        provenance: &graph.provenance,
        module,
        functions: graph
            .functions
            .iter()
            .filter(|function| function.file == module.file)
            .collect(),
    };
    Ok(FileRender {
        stdout: Some(stable_stringify(&payload, pretty)?.into()),
        warning: None,
    })
}
