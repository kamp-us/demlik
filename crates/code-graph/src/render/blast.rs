use super::{ReportRenderError, json::stable_stringify};
use crate::{
    extract::edges::self_recursive_call_count,
    project::{Collation, CollationError, CollationInput, EdgeScope},
    schema::{FunctionNode, Graph, Provenance},
    text::JsString,
};
use indexmap::{IndexMap, IndexSet};
use serde::Serialize;
use std::collections::HashMap;

#[derive(Debug)]
pub struct BlastResult {
    pub stdout: Option<JsString>,
    pub warning: Option<JsString>,
    pub exit_code: i32,
}
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BlastCaller<'g> {
    pub caller_id: &'g str,
    pub file: &'g str,
    pub line: usize,
    pub depth: usize,
}
fn collect_callers<'g>(
    by_id: &HashMap<&'g str, &'g FunctionNode>,
    target: &'g FunctionNode,
    collation: &Collation,
) -> Result<Vec<BlastCaller<'g>>, CollationError> {
    let mut best = IndexMap::<&str, (usize, usize)>::new();
    let mut visited = IndexSet::from([target.id.as_str()]);
    let mut queue = vec![(target.id.as_str(), 0usize)];
    let mut index = 0;
    while let Some(&(id, depth)) = queue.get(index) {
        index += 1;
        let Some(edges) = by_id.get(id).and_then(|node| node.edges.as_ref()) else {
            continue;
        };
        for caller in &edges.called_by {
            if caller.caller_id == target.id {
                continue;
            }
            let next = depth + 1;
            let id = caller.caller_id.as_str();
            if best.get(id).is_none_or(|(previous, _)| next < *previous) {
                best.insert(id, (next, caller.line));
            }
            if visited.insert(id) {
                queue.push((id, next));
            }
        }
    }
    let mut callers = best
        .into_iter()
        .map(|(id, (depth, line))| {
            Ok((
                BlastCaller {
                    caller_id: id,
                    file: by_id.get(id).map_or("", |node| node.file.as_str()),
                    line,
                    depth,
                },
                CollationInput::from_text(id)?,
            ))
        })
        .collect::<Result<Vec<_>, CollationError>>()?;
    callers.sort_by(|(a, ak), (b, bk)| {
        a.depth
            .cmp(&b.depth)
            .then_with(|| collation.compare(ak, bk))
            .then_with(|| a.line.cmp(&b.line))
    });
    Ok(callers.into_iter().map(|(row, _)| row).collect())
}
pub fn render_blast(
    graph: &Graph,
    id_or_name: &JsString,
    json: bool,
    pretty: bool,
    collation: &Collation,
) -> Result<BlastResult, ReportRenderError> {
    let Provenance::Edges { scope, .. } = graph.provenance else {
        return Ok(BlastResult {
            stdout: None,
            warning: Some("warning: --blast requires the edge pass; this graph has none.".into()),
            exit_code: 2,
        });
    };
    let mut targets = graph
        .functions
        .iter()
        .filter(|node| id_or_name == node.id.as_str())
        .collect::<Vec<_>>();
    if targets.is_empty() {
        targets = graph
            .functions
            .iter()
            .filter(|node| id_or_name == node.name.as_str())
            .collect();
    }
    if targets.is_empty() {
        let hint = if graph
            .summary
            .parse_failures
            .iter()
            .any(|file| id_or_name.starts_with(file))
        {
            " (its file is in parseFailures and was excluded)"
        } else {
            ""
        };
        let mut warning = JsString::from("error: no function matches \"");
        warning.extend(id_or_name);
        warning.push_str(&format!(
            "\"{hint}. Pass an id (file:name) from --graph/--plan."
        ));
        return Ok(BlastResult {
            stdout: None,
            warning: Some(warning),
            exit_code: 1,
        });
    }
    if targets.len() > 1 {
        let mut ids = targets
            .iter()
            .map(|node| Ok((node.id.as_str(), CollationInput::from_text(&node.id)?)))
            .collect::<Result<Vec<_>, CollationError>>()?;
        ids.sort_by(|(_, a), (_, b)| collation.compare(a, b));
        let mut warning = JsString::from("error: \"");
        warning.extend(id_or_name);
        warning.push_str(&format!(
            "\" is ambiguous — {} matches. Pass one id:\n",
            ids.len()
        ));
        warning.push_str(
            &ids.into_iter()
                .map(|(id, _)| format!("  {id}"))
                .collect::<Vec<_>>()
                .join("\n"),
        );
        return Ok(BlastResult {
            stdout: None,
            warning: Some(warning),
            exit_code: 1,
        });
    }
    let target = targets[0];
    let by_id = graph
        .functions
        .iter()
        .map(|node| (node.id.as_str(), node))
        .collect();
    let callers = collect_callers(&by_id, target, collation)?;
    let self_calls = self_recursive_call_count(
        &target.id,
        target
            .edges
            .as_ref()
            .map_or(&[], |edges| edges.called_by.as_slice()),
    );
    #[derive(Serialize)]
    #[serde(rename_all = "camelCase")]
    struct Output<'g> {
        target: &'g str,
        scope: EdgeScope,
        target_call_chain_depth: usize,
        cross_package_callers_omitted: bool,
        recursive_self_calls: usize,
        callers: Vec<BlastCaller<'g>>,
    }
    let output = Output {
        target: &target.id,
        scope,
        target_call_chain_depth: target
            .edges
            .as_ref()
            .map_or(0, |edges| edges.call_chain_depth),
        cross_package_callers_omitted: scope == EdgeScope::Package,
        recursive_self_calls: self_calls,
        callers,
    };
    let stdout = if json {
        stable_stringify(&output, pretty)?
    } else {
        let mut lines = vec![
            format!("blast: {}", output.target),
            format!(
                "scope: {}  targetCallChainDepth: {}",
                if scope == EdgeScope::Package {
                    "package"
                } else {
                    "deep"
                },
                output.target_call_chain_depth
            ),
        ];
        if self_calls > 0 {
            lines.push(format!(
                "recursive: {self_calls} self-calls (not counted as fan-in)"
            ));
        }
        if output.callers.is_empty() {
            lines.push("callers: (none in scope)".into());
        } else {
            lines.push(format!("callers ({}):", output.callers.len()));
            lines.extend(output.callers.iter().map(|caller| {
                format!(
                    "  d{}  {}  {}:{}",
                    caller.depth, caller.caller_id, caller.file, caller.line
                )
            }));
        }
        lines.join("\n")
    };
    Ok(BlastResult {
        stdout: Some(stdout.into()),
        warning: (scope == EdgeScope::Package).then(|| "warning: package scope — cross-package callers omitted. Re-run with --deep for the full blast radius.".into()),
        exit_code: 0,
    })
}
