//! Frozen Chalk5.6.2 single-style behavior used by the tree view.
//! The close/reopen and CRLF adaptation is MIT-licensed; see licenses/Chalk-LICENSE.
use crate::{
    project::{Collation, CollationError, CollationInput},
    render::text::pad_end,
    schema::{FunctionNode, Graph},
    text::JsString,
};
use std::collections::HashMap;

/// The host selects a measured terminal profile; parsing does not infer a TTY.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub enum TreeStyle {
    #[default]
    Plain,
    Ansi,
}
enum Style {
    Bold,
    Dim,
    Yellow,
    Cyan,
}
impl Style {
    fn codes(&self) -> (&'static str, &'static str) {
        match self {
            Self::Bold => ("\x1b[1m", "\x1b[22m"),
            Self::Dim => ("\x1b[2m", "\x1b[22m"),
            Self::Yellow => ("\x1b[33m", "\x1b[39m"),
            Self::Cyan => ("\x1b[36m", "\x1b[39m"),
        }
    }
}
impl TreeStyle {
    fn apply(self, style: Style, text: &str) -> String {
        if self == Self::Plain || text.is_empty() {
            return text.into();
        }
        let (open, close) = style.codes();
        // Chalk retains the matching close, then adds its reopen.
        let reopened = text.replace(close, &format!("{close}{open}"));
        let mut out = String::from(open);
        let mut start = 0;
        for (index, character) in reopened.char_indices() {
            if character == '\n' {
                let cr = index > start && reopened.as_bytes()[index - 1] == b'\r';
                out.push_str(&reopened[start..index - usize::from(cr)]);
                out.push_str(close);
                out.push_str(if cr { "\r\n" } else { "\n" });
                out.push_str(open);
                start = index + 1;
            }
        }
        out.push_str(&reopened[start..]);
        out.push_str(close);
        out
    }
}
fn function_line(node: &FunctionNode, last: bool, style: TreeStyle) -> String {
    let name = pad_end(&node.name, 20);
    let colored = if node.smells.is_empty() {
        name
    } else {
        style.apply(Style::Bold, &name)
    };
    let range = pad_end(&format!("L{}-{}", node.start_line, node.end_line), 10);
    let mut line = format!(
        "  {} {colored}{range}loc={} cx={} nest={}",
        if last { "└" } else { "├" },
        node.loc,
        node.complexity,
        node.nesting_depth
    );
    if !node.smells.is_empty() {
        let mut kinds = node
            .smells
            .iter()
            .map(|smell| smell.kind.as_str())
            .collect::<Vec<_>>();
        kinds.sort();
        line.push_str("  ");
        line.push_str(&style.apply(Style::Yellow, &format!("[{}]", kinds.join(","))));
    }
    line
}
pub fn render_tree(
    graph: &Graph,
    style: TreeStyle,
    collation: &Collation,
) -> Result<JsString, CollationError> {
    if graph.modules.is_empty() {
        return Ok("No modules in the graph.".into());
    }
    let mut by_file = HashMap::<&str, Vec<(&FunctionNode, CollationInput)>>::new();
    for node in &graph.functions {
        by_file
            .entry(&node.file)
            .or_default()
            .push((node, CollationInput::from_text(&node.name)?));
    }
    for nodes in by_file.values_mut() {
        nodes.sort_by(|(a, ak), (b, bk)| {
            a.start_line
                .cmp(&b.start_line)
                .then_with(|| collation.compare(ak, bk))
        });
    }
    let mut modules = graph
        .modules
        .iter()
        .map(|module| Ok((module, CollationInput::from_text(&module.file)?)))
        .collect::<Result<Vec<_>, CollationError>>()?;
    modules.sort_by(|(_, a), (_, b)| collation.compare(a, b));
    let mut lines = Vec::new();
    for (module, _) in modules {
        let functions = by_file
            .get(module.file.as_str())
            .map(Vec::as_slice)
            .unwrap_or_default();
        let header = format!(
            "{}  (loc {}, {} fns)",
            module.file,
            module.loc,
            functions.len()
        );
        lines.push(if module.is_test {
            style.apply(Style::Dim, &format!("{header}  [test]"))
        } else {
            style.apply(Style::Cyan, &header)
        });
        for (index, (node, _)) in functions.iter().enumerate() {
            lines.push(function_line(node, index + 1 == functions.len(), style));
        }
    }
    Ok(lines.join("\n").into())
}
