use super::classify::{
    BucketRecord, CommentBucket, CommentClass, CommentShape, buckets_in, classify_comment,
};
use crate::{
    engine::oxc::ParseFailure,
    extract::{
        functions::{is_test_file, js_space},
        metrics::{
            CommentSpan, collect_module_comment_ranges, comment_line_numbers, comment_line_span,
            module_loc,
        },
    },
    project::{discover_package_roots, load_cheap_project, locale_compare},
    syntax::{file::SyntaxFile, trivia::CommentRange},
};
use indexmap::{IndexMap, IndexSet};
use serde::Serialize;
use std::path::Path;

#[derive(Debug, Default, Serialize)]
pub struct CommentTally {
    pub lines: usize,
    pub count: usize,
    pub files: usize,
}
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommentFileRow {
    pub file: String,
    pub loc: usize,
    pub code_lines: usize,
    pub blank_lines: usize,
    pub comment_lines: usize,
    pub mechanical_lines: usize,
    pub protected_lines: usize,
    pub prose_lines: usize,
    pub ratio: f64,
    pub is_test: bool,
    pub buckets: BucketRecord<usize>,
}
#[derive(Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommentScopeRow {
    pub scope: String,
    pub files: usize,
    pub loc: usize,
    pub code_lines: usize,
    pub comment_lines: usize,
    pub mechanical_lines: usize,
    pub protected_lines: usize,
    pub prose_lines: usize,
    pub ratio: f64,
}
#[derive(Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommentTotals {
    pub files: usize,
    pub loc: usize,
    pub code_lines: usize,
    pub blank_lines: usize,
    pub comment_lines: usize,
    pub mechanical_lines: usize,
    pub protected_lines: usize,
    pub prose_lines: usize,
    pub ratio: f64,
}
#[derive(Debug, Serialize)]
pub struct CommentCensus {
    pub totals: CommentTotals,
    pub buckets: BucketRecord<CommentTally>,
    pub scopes: Vec<CommentScopeRow>,
    pub files: Vec<CommentFileRow>,
}
fn ratio_of(comment_lines: usize, code_lines: usize) -> f64 {
    (comment_lines as f64 / code_lines.max(1) as f64 * 1000.0).round() / 1000.0
}
pub fn governed_ratio(row: &CommentScopeRow) -> f64 {
    ratio_of(row.prose_lines + row.mechanical_lines, row.code_lines)
}
fn first_non_import_start(syntax: &SyntaxFile) -> usize {
    syntax
        .root()
        .nodes("body")
        .into_iter()
        .find(|node| node.kind() != "ImportDeclaration")
        .map_or(usize::MAX, |node| node.ts_start())
}
fn tally_buckets(
    syntax: &SyntaxFile,
    ranges: &[CommentSpan],
) -> Result<(BucketRecord<usize>, BucketRecord<usize>), ParseFailure> {
    let mut lines = BucketRecord::new(|| 0);
    let mut counts = BucketRecord::new(|| 0);
    let cutoff = first_non_import_start(syntax);
    let mut claimed = IndexSet::new();
    let mut saw_block = false;
    for range in ranges {
        let is_block = range.text.starts_with("/*");
        let candidate = is_block && !saw_block && range.pos < cutoff;
        saw_block |= is_block;
        let bucket = classify_comment(CommentShape {
            text: &range.text.as_str().into(),
            pos: range.pos,
            file_header_candidate: candidate,
        })?;
        counts[bucket] += 1;
        let (start, end) = comment_line_span(
            syntax,
            CommentRange {
                pos: range.pos,
                end: range.end,
            },
        );
        for line in start..=end {
            if claimed.insert(line) {
                lines[bucket] += 1;
            }
        }
    }
    Ok((lines, counts))
}
fn census_file(
    syntax: &SyntaxFile,
    file: &str,
) -> Result<(CommentFileRow, BucketRecord<usize>), ParseFailure> {
    let ranges = collect_module_comment_ranges(syntax);
    let line_set = comment_line_numbers(
        syntax,
        &ranges
            .iter()
            .map(|span| CommentRange {
                pos: span.pos,
                end: span.end,
            })
            .collect::<Vec<_>>(),
    );
    let comment_lines = line_set.len();
    let loc = module_loc(syntax);
    let text = syntax.text().split('\n').collect::<Vec<_>>();
    let blank_lines = (1..=loc)
        .filter(|line| {
            !line_set.contains(line) && text.get(line - 1).unwrap_or(&"").chars().all(js_space)
        })
        .count();
    let code_lines = loc - comment_lines - blank_lines;
    let (lines, counts) = tally_buckets(syntax, &ranges)?;
    let sum = |class| buckets_in(class).map(|bucket| lines[bucket]).sum();
    Ok((
        CommentFileRow {
            file: file.into(),
            loc,
            code_lines,
            blank_lines,
            comment_lines,
            mechanical_lines: sum(CommentClass::Mechanical),
            protected_lines: sum(CommentClass::Protected),
            prose_lines: sum(CommentClass::Prose),
            ratio: ratio_of(comment_lines, code_lines),
            is_test: is_test_file(file),
            buckets: lines,
        },
        counts,
    ))
}
fn scope_of<'a>(roots: &'a [String], file: &str) -> &'a str {
    roots
        .iter()
        .filter(|root| !root.is_empty() && file.starts_with(&format!("{root}/")))
        .max_by_key(|root| root.len())
        .map_or(".", String::as_str)
}
pub fn load_comment_census(root_absolute: &Path) -> Result<CommentCensus, ParseFailure> {
    let loaded = load_cheap_project(root_absolute, None)?;
    let package_roots = discover_package_roots(root_absolute, None);
    let rows = loaded
        .source_files
        .iter()
        .map(|unit| census_file(&unit.syntax, &unit.file))
        .collect::<Result<Vec<_>, _>>()?;
    let mut totals = CommentTotals {
        files: rows.len(),
        ..CommentTotals::default()
    };
    let mut buckets = BucketRecord::<CommentTally>::new(CommentTally::default);
    let mut scopes = IndexMap::<&str, CommentScopeRow>::new();
    for (row, counts) in &rows {
        totals.loc += row.loc;
        totals.code_lines += row.code_lines;
        totals.blank_lines += row.blank_lines;
        totals.comment_lines += row.comment_lines;
        totals.mechanical_lines += row.mechanical_lines;
        totals.protected_lines += row.protected_lines;
        totals.prose_lines += row.prose_lines;
        for bucket in CommentBucket::ALL {
            let tally = &mut buckets[bucket];
            tally.lines += row.buckets[bucket];
            tally.count += counts[bucket];
            tally.files += usize::from(counts[bucket] > 0);
        }
        let scope = scope_of(&package_roots, &row.file);
        let acc = scopes.entry(scope).or_insert_with(|| CommentScopeRow {
            scope: scope.into(),
            ..CommentScopeRow::default()
        });
        acc.files += 1;
        acc.loc += row.loc;
        acc.code_lines += row.code_lines;
        acc.comment_lines += row.comment_lines;
        acc.mechanical_lines += row.mechanical_lines;
        acc.protected_lines += row.protected_lines;
        acc.prose_lines += row.prose_lines;
    }
    totals.ratio = ratio_of(totals.comment_lines, totals.code_lines);
    let mut scopes = scopes.into_values().collect::<Vec<_>>();
    for scope in &mut scopes {
        scope.ratio = ratio_of(scope.comment_lines, scope.code_lines);
    }
    scopes.sort_by(|left, right| {
        right
            .comment_lines
            .cmp(&left.comment_lines)
            .then_with(|| locale_compare(&left.scope, &right.scope))
    });
    let mut files = rows.into_iter().map(|(row, _)| row).collect::<Vec<_>>();
    files.sort_by(|left, right| {
        right
            .comment_lines
            .cmp(&left.comment_lines)
            .then_with(|| locale_compare(&left.file, &right.file))
    });
    Ok(CommentCensus {
        totals,
        buckets,
        scopes,
        files,
    })
}
