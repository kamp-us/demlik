use super::ports::{HexagonBag, HexagonMember, HexagonPort, NotRead, read_ports};
use crate::{
    engine::oxc::{ParseFailure, parse_type_script},
    project::{basename_path_text, join_path_text, list_source_files, to_relative},
    syntax::{SyntaxFile, file::NodeRef},
    text::JsString,
};
use indexmap::IndexSet;
use serde::{Deserialize, Serialize};
use std::{fs, io, path::Path};

#[derive(Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Hexagon {
    pub feature: Option<JsString>,
    pub commands: Vec<HexagonMember>,
    pub external_systems: Vec<HexagonMember>,
    pub other_bags: Vec<HexagonBag>,
    pub unbagged_ports: Vec<HexagonPort>,
    pub use_cases: Vec<UseCase>,
    pub adapters: Adapters,
    pub not_read: Vec<NotRead>,
}
#[derive(Debug, Serialize, Deserialize)]
pub struct UseCase {
    pub file: JsString,
    pub functions: Vec<JsString>,
}
#[derive(Debug, Default, Serialize, Deserialize)]
pub struct Adapters {
    pub driving: Vec<JsString>,
    pub driven: Vec<JsString>,
}
#[derive(Debug)]
pub enum HexagonReadError {
    Directory { path: JsString, source: io::Error },
    MissingPorts { path: JsString },
    Parser(ParseFailure),
}
impl HexagonReadError {
    pub fn message(&self) -> JsString {
        match self {
            Self::Directory { path, .. } | Self::MissingPorts { path } => {
                let mut message = JsString::from(if matches!(self, Self::Directory { .. }) {
                    "cannot read directory: "
                } else {
                    "missing ports.ts: "
                });
                message.extend(path);
                message
            }
            Self::Parser(error) => error.to_string().into(),
        }
    }
}
impl std::fmt::Display for HexagonReadError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.message().to_lossy())
    }
}
impl std::error::Error for HexagonReadError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Self::Directory { source, .. } => Some(source),
            Self::Parser(error) => Some(error),
            Self::MissingPorts { .. } => None,
        }
    }
}
fn directory(path: &JsString, recursive: bool) -> Result<(), HexagonReadError> {
    let failure = |source| HexagonReadError::Directory {
        path: path.clone(),
        source,
    };
    let mut entries = fs::read_dir(path.to_lossy())
        .map_err(failure)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(failure)?;
    if recursive {
        // Pinned Node directory order is by filename bytes, independently of report UTF-16 order.
        entries.sort_by_key(|entry| entry.file_name());
        for entry in entries {
            let name = entry.file_name().to_string_lossy().into_owned();
            if entry.file_type().map_err(failure)?.is_dir()
                && !name.starts_with('.')
                && !["node_modules", "vendor", "dist", "__generated__"].contains(&name.as_str())
            {
                directory(&join_path_text(path, &name.into()), true)?;
            }
        }
    }
    Ok(())
}
fn check_layout(root: &JsString) -> Result<(), HexagonReadError> {
    directory(root, false)?;
    let path = join_path_text(root, &"ports.ts".into());
    if !Path::new(&path.to_lossy()).exists() {
        return Err(HexagonReadError::MissingPorts { path });
    }
    for name in ["application", "adapters"] {
        let path = join_path_text(root, &name.into());
        if Path::new(&path.to_lossy()).exists() {
            directory(&path, name == "adapters")?;
        }
    }
    Ok(())
}
fn read_syntax(
    root: &JsString,
    file: &JsString,
    not_read: &mut Vec<NotRead>,
) -> Result<Option<SyntaxFile>, HexagonReadError> {
    let path = join_path_text(root, file);
    let bytes = match fs::read(path.to_lossy()) {
        Ok(bytes) => bytes,
        Err(_) => {
            not_read.push(NotRead {
                file: file.clone(),
                line: 1.0,
                name: "<source>".into(),
                reason: "cannot read source".into(),
            });
            return Ok(None);
        }
    };
    match parse_type_script(
        Path::new(&file.to_lossy()),
        &String::from_utf8_lossy(&bytes),
    ) {
        Ok(syntax) => Ok(Some(syntax)),
        Err(ParseFailure::Syntax(_)) => {
            not_read.push(NotRead {
                file: file.clone(),
                line: 1.0,
                name: "<source>".into(),
                reason: "cannot parse source".into(),
            });
            Ok(None)
        }
        Err(error) => Err(HexagonReadError::Parser(error)),
    }
}
fn function_names(node: Option<NodeRef<'_>>) -> Vec<JsString> {
    let Some(node) = node else {
        return Vec::new();
    };
    if node.kind() == "FunctionDeclaration"
        && node.node("id").is_some()
        && node.node("body").is_some()
    {
        return vec![
            node.node("id")
                .unwrap()
                .string("name")
                .unwrap_or("undefined")
                .into(),
        ];
    }
    if node.kind() != "VariableDeclaration" || node.string("kind") != Some("const") {
        return Vec::new();
    }
    node.nodes("declarations")
        .into_iter()
        .filter_map(|binding| {
            let id = binding.node("id")?;
            if id.kind() != "Identifier"
                || !binding.node("init").is_some_and(|init| {
                    matches!(
                        init.kind(),
                        "ArrowFunctionExpression" | "FunctionExpression"
                    )
                })
            {
                return None;
            }
            Some(id.string("name").unwrap_or("undefined").into())
        })
        .collect()
}
fn exported_functions(syntax: Option<&SyntaxFile>) -> Vec<JsString> {
    let mut names = IndexSet::new();
    if let Some(syntax) = syntax {
        for statement in syntax.root().nodes("body") {
            if statement.kind() == "ExportNamedDeclaration" {
                names.extend(function_names(statement.node("declaration")));
            }
        }
    }
    let mut names: Vec<_> = names.into_iter().collect();
    names.sort();
    names
}
fn factory_feature(
    root: &JsString,
    use_cases: &[UseCase],
    bags: &[HexagonBag],
) -> Option<JsString> {
    let mut preferred = JsString::from("application/");
    preferred.extend(&basename_path_text(root));
    preferred.push_str(".ts");
    let names: IndexSet<_> = bags.iter().map(|bag| &bag.name).collect();
    let mut factories: Vec<_> = use_cases
        .iter()
        .flat_map(|case| {
            case.functions.iter().filter_map(|name| {
                if name.starts_with("create")
                    && name
                        .units()
                        .get(6)
                        .is_some_and(|unit| matches!(*unit, 65..=90))
                {
                    Some((&case.file, name))
                } else {
                    None
                }
            })
        })
        .collect();
    let score = |(file, name): (&JsString, &JsString)| {
        if file == &preferred {
            return 0;
        }
        let feature = JsString::from_units(name.units()[6..].to_vec());
        let mut driven = feature.clone();
        driven.push_str("Driven");
        if names.contains(&feature) && names.contains(&driven) {
            1
        } else {
            2
        }
    };
    factories.sort_by(|a, b| {
        score(*a)
            .cmp(&score(*b))
            .then_with(|| a.0.cmp(b.0))
            .then_with(|| a.1.cmp(b.1))
    });
    factories
        .first()
        .map(|(_, name)| JsString::from_units(name.units()[6..].to_vec()))
}
pub fn read_hexagon(root: &JsString) -> Result<Hexagon, HexagonReadError> {
    check_layout(root)?;
    let mut not_read = Vec::new();
    let syntax = read_syntax(root, &"ports.ts".into(), &mut not_read)?;
    let ports = read_ports(syntax.as_ref(), &mut not_read);
    let native = root.to_lossy();
    let path = Path::new(&native);
    let mut files: Vec<JsString> = list_source_files(path)
        .iter()
        .map(|file| to_relative(path, file).into())
        .collect();
    files.sort();
    let mut use_cases = Vec::new();
    for file in &files {
        let units = file.units();
        if file.starts_with("application/")
            && units.ends_with(&[116, 115])
            && units.len() >= 3
            && units[units.len() - 3] == 46
            && !units[12..].contains(&47)
        {
            let syntax = read_syntax(root, file, &mut not_read)?;
            use_cases.push(UseCase {
                file: file.clone(),
                functions: exported_functions(syntax.as_ref()),
            });
        }
    }
    let feature = factory_feature(root, &use_cases, &ports.bags);
    let driven = feature.as_ref().map(|feature| {
        let mut name = feature.clone();
        name.push_str("Driven");
        name
    });
    let mut commands = Vec::new();
    let mut external_systems = Vec::new();
    let mut other_bags = Vec::new();
    for bag in ports.bags {
        if feature.as_ref() == Some(&bag.name) {
            commands = bag.members;
        } else if driven.as_ref() == Some(&bag.name) {
            external_systems = bag.members;
        } else {
            other_bags.push(bag);
        }
    }
    not_read.sort_by(|a, b| {
        a.file
            .cmp(&b.file)
            .then_with(|| a.line.total_cmp(&b.line))
            .then_with(|| a.name.cmp(&b.name))
            .then_with(|| a.reason.cmp(&b.reason))
    });
    let adapters = Adapters {
        driving: files
            .iter()
            .filter(|file| file.starts_with("adapters/driving/"))
            .cloned()
            .collect(),
        driven: files
            .iter()
            .filter(|file| file.starts_with("adapters/driven/"))
            .cloned()
            .collect(),
    };
    Ok(Hexagon {
        feature,
        commands,
        external_systems,
        other_bags,
        unbagged_ports: ports.unbagged_ports,
        use_cases,
        adapters,
        not_read,
    })
}
