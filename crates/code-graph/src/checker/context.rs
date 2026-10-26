use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::rc::Rc;

use indexmap::IndexMap;

use crate::engine::tsgo::{
    LibraryKind, NativeFile, NativeNode, NativeSymbol, ProgramInput, TextProgramInput, TsgoBinary,
    TsgoError, TypeProgram, native_kind, open_type_session, open_type_session_text,
};
use crate::extract::functions::{DiscoveredFunction, FunctionKind};
use crate::project::{
    LoadedProject, SourceUnit, join_path_text, selected_config_text, to_relative,
};
use crate::text::JsString;

#[derive(Clone)]
pub struct TypedFile {
    pub unit: Rc<SourceUnit>,
    pub source: NativeFile,
}
#[derive(Clone, Copy)]
pub struct TypeContextInput<'a> {
    pub project: &'a LoadedProject,
    pub ts_config_path: &'a Path,
    pub functions: &'a [DiscoveredFunction],
}

pub struct TypeContext<'program, 'channel> {
    program: &'program mut TypeProgram<'channel>,
    pub root_absolute: PathBuf,
    root_real: PathBuf,
    pub node_to_id: IndexMap<NativeNode, String>,
    pub files: Vec<TypedFile>,
    pub unjoined: Vec<String>,
    symbols: HashMap<NativeNode, Option<NativeSymbol>>,
    aliases: HashMap<NativeSymbol, Option<NativeSymbol>>,
    by_file_name: HashMap<PathBuf, Rc<SourceUnit>>,
}

fn function_kind(kind: FunctionKind) -> u32 {
    native_kind(match kind {
        FunctionKind::Function => "FunctionDeclaration",
        FunctionKind::Method => "MethodDeclaration",
        FunctionKind::Constructor => "Constructor",
        FunctionKind::Getter => "GetAccessor",
        FunctionKind::Setter => "SetAccessor",
        FunctionKind::Arrow => "ArrowFunction",
        FunctionKind::FunctionExpression => "FunctionExpression",
    })
}

/// The program and compiler process close when this scope returns, including typed error paths.
pub fn with_type_context<T>(
    binary: &TsgoBinary,
    input: TypeContextInput<'_>,
    read: impl FnOnce(&mut TypeContext<'_, '_>) -> Result<T, TsgoError>,
) -> Result<T, TsgoError> {
    with_type_context_in(binary, input, None, read)
}

/// Reuse the original logical root supplied to `load_edge_project_text`.
/// The loaded input owns filesystem Paths; this spelling retains its UTF-16 for the compiler.
pub fn with_type_context_text<T>(
    binary: &TsgoBinary,
    input: TypeContextInput<'_>,
    root_text: &JsString,
    read: impl FnOnce(&mut TypeContext<'_, '_>) -> Result<T, TsgoError>,
) -> Result<T, TsgoError> {
    with_type_context_in(binary, input, Some(root_text), read)
}

fn with_type_context_in<T>(
    binary: &TsgoBinary,
    input: TypeContextInput<'_>,
    root_text: Option<&JsString>,
    read: impl FnOnce(&mut TypeContext<'_, '_>) -> Result<T, TsgoError>,
) -> Result<T, TsgoError> {
    let config_text = root_text.map(|root| selected_config_text(root, input.ts_config_path));
    let mut session = match config_text.as_ref() {
        Some(config) => open_type_session_text(binary, config)?,
        None => open_type_session(binary, input.ts_config_path)?,
    };
    let text_roots = root_text.map(|root| {
        input
            .project
            .source_files
            .iter()
            .map(|unit| join_path_text(root, &unit.file.as_str().into()))
            .collect::<Vec<_>>()
    });
    let read_program = |program: &mut TypeProgram<'_>| {
        let mut context = TypeContext::new(program, input, text_roots.as_deref())?;
        read(&mut context)
    };
    match text_roots.as_ref() {
        Some(roots) => session.with_compilation_text(
            TextProgramInput {
                root_files: roots,
                include_config_files: true,
            },
            read_program,
        ),
        None => {
            let roots: Vec<_> = input
                .project
                .source_files
                .iter()
                .map(|unit| unit.absolute_path.clone())
                .collect();
            session.with_compilation(
                ProgramInput {
                    root_files: &roots,
                    include_config_files: true,
                },
                read_program,
            )
        }
    }
}

impl<'program, 'channel> TypeContext<'program, 'channel> {
    fn new(
        program: &'program mut TypeProgram<'channel>,
        input: TypeContextInput<'_>,
        text_roots: Option<&[JsString]>,
    ) -> Result<Self, TsgoError> {
        let root_absolute = input.project.root_absolute.clone();
        let root_real = fs::canonicalize(&root_absolute).unwrap_or_else(|_| root_absolute.clone());
        let mut files = Vec::new();
        let mut by_file_name = HashMap::new();
        for (index, unit) in input.project.source_files.iter().enumerate() {
            let source = match text_roots {
                Some(roots) => program.source_file_text(&roots[index])?,
                None => program.source_file(&unit.absolute_path)?,
            };
            let Some(source) = source else {
                continue;
            };
            by_file_name.insert(source.file_name().to_path_buf(), unit.clone());
            files.push(TypedFile {
                unit: unit.clone(),
                source,
            });
        }
        let mut context = Self {
            program,
            root_absolute,
            root_real,
            node_to_id: IndexMap::new(),
            files,
            unjoined: Vec::new(),
            symbols: HashMap::new(),
            aliases: HashMap::new(),
            by_file_name,
        };
        context.join(input.functions)?;
        Ok(context)
    }
    fn join(&mut self, functions: &[DiscoveredFunction]) -> Result<(), TsgoError> {
        let mut wanted: HashMap<&str, HashMap<(usize, u32), &str>> = HashMap::new();
        for function in functions {
            wanted.entry(&function.file).or_default().insert(
                (function.node().ts_start(), function_kind(function.kind)),
                &function.id,
            );
        }
        let mut joined = HashSet::new();
        for file in &self.files {
            let Some(by_key) = wanted.get(file.unit.file.as_str()) else {
                continue;
            };
            let kinds: HashSet<_> = by_key.keys().map(|(_, kind)| *kind).collect();
            for node in file.source.root().descendants()? {
                if !kinds.contains(&node.kind()) {
                    continue;
                }
                if let Some(id) = by_key.get(&(node.start()?, node.kind())) {
                    self.node_to_id.insert(node, (*id).to_owned());
                    joined.insert(*id);
                }
            }
        }
        self.unjoined = functions
            .iter()
            .filter(|function| !joined.contains(function.id.as_str()))
            .map(|function| function.id.clone())
            .collect();
        Ok(())
    }
    pub fn unit_of(&self, source: &NativeFile) -> Option<Rc<SourceUnit>> {
        self.by_file_name.get(source.file_name()).cloned()
    }
    pub fn symbol_of(&mut self, node: &NativeNode) -> Result<Option<NativeSymbol>, TsgoError> {
        if let Some(symbol) = self.symbols.get(node) {
            return Ok(symbol.clone());
        }
        let mut symbol = self.program.symbol_at(node)?;
        if symbol.is_none()
            && let Some(name) = node.node("name")?
        {
            symbol = self.program.symbol_at(&name)?;
        }
        self.symbols.insert(node.clone(), symbol.clone());
        Ok(symbol)
    }
    pub fn prefetch_symbols(&mut self, nodes: &[NativeNode]) -> Result<(), TsgoError> {
        let missing: Vec<_> = nodes
            .iter()
            .filter(|node| !self.symbols.contains_key(*node))
            .cloned()
            .collect();
        let found = self.program.symbols_at(&missing)?;
        for (node, symbol) in missing.into_iter().zip(found) {
            if let Some(symbol) = symbol {
                self.symbols.insert(node, Some(symbol));
            }
        }
        Ok(())
    }
    pub fn aliased_symbol(
        &mut self,
        symbol: &NativeSymbol,
    ) -> Result<Option<NativeSymbol>, TsgoError> {
        if let Some(target) = self.aliases.get(symbol) {
            return Ok(target.clone());
        }
        let target = self.program.alias_target(symbol)?;
        self.aliases.insert(symbol.clone(), target.clone());
        Ok(target)
    }
    pub fn shorthand_value_symbol(
        &mut self,
        assignment: &NativeNode,
    ) -> Result<Option<NativeSymbol>, TsgoError> {
        self.program.shorthand_value_symbol(assignment)
    }
    pub fn declarations_of(&mut self, symbol: &NativeSymbol) -> Result<Vec<NativeNode>, TsgoError> {
        self.program.declarations(symbol)
    }
    pub fn exports_of(
        &mut self,
        symbol: &NativeSymbol,
    ) -> Result<IndexMap<String, NativeSymbol>, TsgoError> {
        self.program.exports_of(symbol)
    }
    pub fn library_kind(&mut self, source: &NativeFile) -> Result<Option<LibraryKind>, TsgoError> {
        self.program.library_kind(source)
    }
    pub fn start_line(&self, node: &NativeNode) -> Result<usize, TsgoError> {
        node.start_line()
    }
    pub fn text(&self, node: &NativeNode) -> Result<String, TsgoError> {
        node.text()
    }
    pub fn relative_path(&self, source: &NativeFile) -> String {
        if let Some(unit) = self.by_file_name.get(source.file_name()) {
            return unit.file.clone();
        }
        let file = source.file_name();
        let root = if file != self.root_real && file.starts_with(&self.root_real) {
            &self.root_real
        } else {
            &self.root_absolute
        };
        to_relative(root, file)
    }
}
