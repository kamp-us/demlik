use crate::schema::{Severity, SmellKind, SmellTarget, Thresholds};

pub struct FunctionFacts<'a> {
    pub id: &'a str,
    pub file: &'a str,
    pub start_line: usize,
    pub loc: usize,
    pub comment_lines: usize,
    pub nesting_depth: usize,
    pub complexity: usize,
    pub called_by_count: Option<usize>,
    pub call_chain_depth: Option<usize>,
}
pub struct ModuleFacts<'a> {
    pub file: &'a str,
    pub loc: usize,
    pub cycle_size: Option<usize>,
    pub cross_boundary_out_count: Option<usize>,
}
pub struct DirectoryFacts<'a> {
    pub dir: &'a str,
    pub file_count: usize,
}
pub struct RuleContext<'a> {
    pub function: Option<&'a FunctionFacts<'a>>,
    pub module: Option<&'a ModuleFacts<'a>>,
    pub directory: Option<&'a DirectoryFacts<'a>>,
    pub thresholds: &'a Thresholds,
}
pub struct RawSmell {
    pub target: SmellTarget,
    pub value: usize,
    pub threshold: u64,
    pub severity: Severity,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MeasuredBy {
    Syntax,
    Edges,
}

pub fn smell_kinds() -> [SmellKind; 10] {
    SmellKind::ALL
}
pub fn measured_by(kind: SmellKind) -> MeasuredBy {
    match kind {
        SmellKind::HighFanIn
        | SmellKind::DeepCallChain
        | SmellKind::DependencyCycle
        | SmellKind::CrossBoundaryImport => MeasuredBy::Edges,
        SmellKind::LongFunction
        | SmellKind::DeepNesting
        | SmellKind::HighComplexity
        | SmellKind::DenseUndocumented
        | SmellKind::BigFile
        | SmellKind::DirectorySprawl => MeasuredBy::Syntax,
    }
}

fn raw_smell(kind: SmellKind, context: &RuleContext<'_>) -> Option<RawSmell> {
    let t = context.thresholds;
    let (target, value, threshold) = match kind {
        SmellKind::LongFunction
        | SmellKind::DeepNesting
        | SmellKind::HighComplexity
        | SmellKind::DenseUndocumented
        | SmellKind::HighFanIn
        | SmellKind::DeepCallChain => {
            let function = context.function?;
            let (value, threshold) = match kind {
                SmellKind::LongFunction => (function.loc, t.long_function_loc),
                SmellKind::DeepNesting => (function.nesting_depth, t.deep_nesting),
                SmellKind::HighComplexity => (function.complexity, t.high_complexity),
                SmellKind::DenseUndocumented => {
                    if function.comment_lines != 0 {
                        return None;
                    }
                    (function.complexity, t.high_complexity)
                }
                SmellKind::HighFanIn => (function.called_by_count?, t.high_fan_in),
                SmellKind::DeepCallChain => (function.call_chain_depth?, t.deep_call_chain),
                _ => unreachable!("function rule group"),
            };
            (
                SmellTarget::Function {
                    id: function.id.into(),
                    file: function.file.into(),
                    start_line: function.start_line,
                },
                value,
                threshold,
            )
        }
        SmellKind::BigFile | SmellKind::DependencyCycle | SmellKind::CrossBoundaryImport => {
            let module = context.module?;
            let (value, threshold) = match kind {
                SmellKind::BigFile => (module.loc, t.big_file_loc),
                SmellKind::DependencyCycle => (module.cycle_size?, t.dependency_cycle),
                SmellKind::CrossBoundaryImport => {
                    (module.cross_boundary_out_count?, t.cross_boundary_imports)
                }
                _ => unreachable!("module rule group"),
            };
            (
                SmellTarget::Module {
                    file: module.file.into(),
                },
                value,
                threshold,
            )
        }
        SmellKind::DirectorySprawl => {
            let directory = context.directory?;
            (
                SmellTarget::Directory {
                    dir: directory.dir.into(),
                },
                directory.file_count,
                t.directory_sprawl,
            )
        }
    };
    if value as u64 <= threshold {
        return None;
    }
    let high = match kind {
        SmellKind::DependencyCycle => value >= 4,
        SmellKind::CrossBoundaryImport => value >= 5,
        _ => value as f64 >= 2.0 * threshold as f64,
    };
    Some(RawSmell {
        target,
        value,
        threshold,
        severity: if high { Severity::High } else { Severity::Warn },
    })
}

pub fn evaluate_rule(kind: SmellKind, context: &RuleContext<'_>) -> Vec<RawSmell> {
    raw_smell(kind, context).into_iter().collect()
}
