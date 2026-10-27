use crate::{
    project::{Collation, CollationError, CollationInput},
    render::{ReportRenderError, json::stable_stringify},
    schema::{DeclarationNode, FunctionNode, Graph, Provenance, UseSite},
    text::JsString,
};
use indexmap::IndexMap;
use serde::{Serialize, Serializer, ser::SerializeStruct};
use std::collections::HashMap;

/// Matches retain the authoritative graph node. Only function call-site rows are newly made.
#[derive(Debug)]
pub enum FindMatch<'g> {
    Function {
        node: &'g FunctionNode,
        uses: Option<Vec<UseSite>>,
    },
    Declaration(&'g DeclarationNode),
}
impl FindMatch<'_> {
    pub fn id(&self) -> &str {
        match self {
            Self::Function { node, .. } => &node.id,
            Self::Declaration(node) => &node.id,
        }
    }
    pub fn file(&self) -> &str {
        match self {
            Self::Function { node, .. } => &node.file,
            Self::Declaration(node) => &node.file,
        }
    }
    pub fn line(&self) -> usize {
        match self {
            Self::Function { node, .. } => node.start_line,
            Self::Declaration(node) => node.line,
        }
    }
    pub fn uses(&self) -> Option<&[UseSite]> {
        match self {
            Self::Function { uses, .. } => uses.as_deref(),
            Self::Declaration(node) => node.uses.as_deref(),
        }
    }
}
impl Serialize for FindMatch<'_> {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        let mut row = serializer.serialize_struct("FindMatch", 7)?;
        row.serialize_field("id", self.id())?;
        match self {
            Self::Function { node, .. } => {
                row.serialize_field("name", &node.name)?;
                row.serialize_field("kind", &node.kind)?;
                row.serialize_field("file", &node.file)?;
                row.serialize_field("line", &node.start_line)?;
                row.serialize_field("isExported", &node.is_exported)?;
            }
            Self::Declaration(node) => {
                row.serialize_field("name", &node.name)?;
                row.serialize_field("kind", &node.kind)?;
                row.serialize_field("file", &node.file)?;
                row.serialize_field("line", &node.line)?;
                row.serialize_field("isExported", &node.is_exported)?;
            }
        }
        row.serialize_field("uses", &self.uses())?;
        row.end()
    }
}
fn call_sites(
    node: &FunctionNode,
    file_of: &HashMap<&str, &str>,
    collation: &Collation,
) -> Result<Option<Vec<UseSite>>, CollationError> {
    let Some(edges) = &node.edges else {
        return Ok(None);
    };
    let mut sites = IndexMap::new();
    for caller in &edges.called_by {
        let file = file_of
            .get(caller.caller_id.as_str())
            .copied()
            .unwrap_or("");
        // Preserve Source's literal delimiter key and last-value/first-position semantics.
        sites.insert(
            format!("{file}:{}", caller.line),
            UseSite {
                file: file.into(),
                line: caller.line,
            },
        );
    }
    let mut sites = sites
        .into_values()
        .map(|site| {
            let key = CollationInput::from_text(&site.file)?;
            Ok((site, key))
        })
        .collect::<Result<Vec<_>, CollationError>>()?;
    sites.sort_by(|(a, ak), (b, bk)| collation.compare(ak, bk).then_with(|| a.line.cmp(&b.line)));
    Ok(Some(sites.into_iter().map(|(site, _)| site).collect()))
}
pub fn find_by_name<'g>(
    graph: &'g Graph,
    name: &JsString,
    collation: &Collation,
) -> Result<Vec<FindMatch<'g>>, CollationError> {
    let file_of = graph
        .functions
        .iter()
        .map(|node| (node.id.as_str(), node.file.as_str()))
        .collect();
    let mut matches = Vec::new();
    for node in graph
        .functions
        .iter()
        .filter(|node| name == node.name.as_str())
    {
        matches.push(FindMatch::Function {
            node,
            uses: call_sites(node, &file_of, collation)?,
        });
    }
    matches.extend(
        graph
            .declarations
            .iter()
            .filter(|node| name == node.name.as_str())
            .map(FindMatch::Declaration),
    );
    let mut keyed = matches
        .into_iter()
        .map(|row| {
            let file = CollationInput::from_text(row.file())?;
            let id = CollationInput::from_text(row.id())?;
            Ok((row, file, id))
        })
        .collect::<Result<Vec<_>, CollationError>>()?;
    keyed.sort_by(|(a, af, ai), (b, bf, bi)| {
        collation
            .compare(af, bf)
            .then_with(|| a.line().cmp(&b.line()))
            .then_with(|| collation.compare(ai, bi))
    });
    Ok(keyed.into_iter().map(|(row, _, _)| row).collect())
}
#[derive(Debug)]
pub struct FindResult {
    pub stdout: Option<JsString>,
    pub warning: Option<JsString>,
    pub exit_code: i32,
}
pub fn render_find(
    graph: &Graph,
    name: &JsString,
    pretty: bool,
    collation: &Collation,
) -> Result<FindResult, ReportRenderError> {
    let Provenance::Edges { scope, .. } = graph.provenance else {
        return Ok(FindResult {
            stdout: None,
            warning: Some("warning: --find requires the edge pass; this graph has none.".into()),
            exit_code: 2,
        });
    };
    let matches = find_by_name(graph, name, collation)?;
    let warning = matches.is_empty().then(|| {
        let mut message = JsString::from("warning: no function or declaration is named \"");
        message.extend(name);
        message.push_str("\".");
        message
    });
    #[derive(Serialize)]
    struct Output<'g, 'n> {
        name: &'n JsString,
        scope: crate::project::EdgeScope,
        matches: Vec<FindMatch<'g>>,
    }
    Ok(FindResult {
        stdout: Some(
            stable_stringify(
                &Output {
                    name,
                    scope,
                    matches,
                },
                pretty,
            )?
            .into(),
        ),
        warning,
        exit_code: 0,
    })
}
