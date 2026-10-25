use crate::{syntax::imports::ImportEdge, text::JsString};
use indexmap::IndexSet;
use serde::Serialize;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(tag = "shape", rename_all = "kebab-case")]
pub enum ImpureShape {
    Path,
    Members { of: &'static str },
    BareNew { ctor: &'static str },
    Module,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ImpureRow {
    pub name: &'static str,
    pub shape: ImpureShape,
}
pub const GLOBAL_OBJECT: &str = "globalThis";
pub const IMPURE_GLOBALS: &[ImpureRow] = &[
    ImpureRow {
        name: "process.<member>",
        shape: ImpureShape::Members { of: "process" },
    },
    ImpureRow {
        name: "Date.now",
        shape: ImpureShape::Path,
    },
    ImpureRow {
        name: "Math.random",
        shape: ImpureShape::Path,
    },
    ImpureRow {
        name: "crypto.randomUUID",
        shape: ImpureShape::Path,
    },
    ImpureRow {
        name: "crypto.getRandomValues",
        shape: ImpureShape::Path,
    },
    ImpureRow {
        name: "performance.now",
        shape: ImpureShape::Path,
    },
    ImpureRow {
        name: "fetch",
        shape: ImpureShape::Path,
    },
    ImpureRow {
        name: "setTimeout",
        shape: ImpureShape::Path,
    },
    ImpureRow {
        name: "setInterval",
        shape: ImpureShape::Path,
    },
    ImpureRow {
        name: "globalThis",
        shape: ImpureShape::Path,
    },
    ImpureRow {
        name: "console",
        shape: ImpureShape::Path,
    },
    ImpureRow {
        name: "new Date()",
        shape: ImpureShape::BareNew { ctor: "Date" },
    },
    ImpureRow {
        name: "node:fs",
        shape: ImpureShape::Module,
    },
    ImpureRow {
        name: "node:child_process",
        shape: ImpureShape::Module,
    },
];
pub fn impure_rows() -> impl Iterator<Item = &'static str> {
    IMPURE_GLOBALS.iter().map(|row| row.name)
}
pub fn impure_path_of(path: &[JsString]) -> Option<JsString> {
    for row in IMPURE_GLOBALS {
        let (prefix, members) = match row.shape {
            ImpureShape::Path => (row.name, 0),
            ImpureShape::Members { of } => (of, 1),
            ImpureShape::BareNew { .. } | ImpureShape::Module => continue,
        };
        let mut count = 0;
        let matches = prefix.split('.').all(|segment| {
            let equal = path.get(count).is_some_and(|part| part == segment);
            count += 1;
            equal
        });
        let named = count + members;
        if matches && path.len() >= named {
            let mut name = JsString::default();
            for (index, part) in path[..named].iter().enumerate() {
                if index > 0 {
                    name.push_str(".");
                }
                name.extend(part);
            }
            return Some(name);
        }
    }
    None
}
pub fn impure_bare_new_of(ctor: &JsString) -> Option<JsString> {
    IMPURE_GLOBALS.iter().find_map(|row| match row.shape {
        ImpureShape::BareNew { ctor: expected } if ctor == expected => Some(row.name.into()),
        ImpureShape::Path
        | ImpureShape::Members { .. }
        | ImpureShape::BareNew { .. }
        | ImpureShape::Module => None,
    })
}
pub fn impure_module_of(edge: &ImportEdge) -> Option<JsString> {
    if edge.target.is_some() || edge.type_only {
        return None;
    }
    let specifier = edge.specifier.units();
    let specifier = if edge.specifier.starts_with("node:") {
        &specifier[5..]
    } else {
        specifier
    };
    let head = specifier
        .split(|unit| *unit == 47)
        .next()
        .unwrap_or_default();
    IMPURE_GLOBALS.iter().find_map(|row| match row.shape {
        ImpureShape::Module
            if row
                .name
                .strip_prefix("node:")
                .unwrap_or(row.name)
                .encode_utf16()
                .eq(head.iter().copied()) =>
        {
            Some(row.name.into())
        }
        ImpureShape::Path
        | ImpureShape::Members { .. }
        | ImpureShape::BareNew { .. }
        | ImpureShape::Module => None,
    })
}
pub fn impure_modules_opened(edges: &[ImportEdge], runtime: &IndexSet<JsString>) -> Vec<JsString> {
    edges
        .iter()
        .filter(|edge| runtime.contains(&edge.specifier))
        .filter_map(impure_module_of)
        .collect()
}
