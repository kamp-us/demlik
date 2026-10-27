use super::{
    census::{CommentCensus, CommentFileRow, CommentScopeRow},
    classify::{CommentBucket, CommentClass, buckets_in},
};
use crate::{
    project::{Collation, CollationError, CollationInput},
    render::{
        json::stable_stringify,
        text::{fixed, grouped, pad_end, pad_start},
    },
};

const HUMAN_FILE_LIMIT: usize = 20;
const HUMAN_SCOPE_LIMIT: usize = 20;
fn pct(value: f64) -> String {
    format!("{}%", fixed(value * 100.0, 1))
}
fn bucket_line(census: &CommentCensus, bucket: CommentBucket) -> String {
    let tally = &census.buckets[bucket];
    format!(
        "  {}{}{}{}",
        pad_end(bucket.as_str(), 20),
        pad_start(&grouped(tally.lines), 8),
        pad_start(&grouped(tally.count), 11),
        pad_start(&grouped(tally.files), 8)
    )
}
fn bucket_group(
    census: &CommentCensus,
    class: CommentClass,
    heading: &str,
    collation: &Collation,
) -> Result<Vec<String>, CollationError> {
    let mut buckets = buckets_in(class)
        .map(|bucket| CollationInput::from_text(bucket.as_str()).map(|input| (bucket, input)))
        .collect::<Result<Vec<_>, _>>()?;
    buckets.sort_by(|a, b| {
        census.buckets[b.0]
            .lines
            .cmp(&census.buckets[a.0].lines)
            .then_with(|| collation.compare(&a.1, &b.1))
    });
    Ok(std::iter::once(heading.into())
        .chain(
            buckets
                .into_iter()
                .map(|(bucket, _)| bucket_line(census, bucket)),
        )
        .collect())
}
fn bucket_table(census: &CommentCensus, collation: &Collation) -> Result<String, CollationError> {
    let mut lines = vec![format!(
        "  {}{}{}{}",
        pad_end("bucket", 20),
        pad_start("lines", 8),
        pad_start("comments", 11),
        pad_start("files", 8)
    )];
    lines.extend(bucket_group(
        census,
        CommentClass::Mechanical,
        "  ---- mechanical (no judgment needed) ----",
        collation,
    )?);
    lines.extend(bucket_group(
        census,
        CommentClass::Prose,
        "  ---- prose (judgment required) ----",
        collation,
    )?);
    lines.extend(bucket_group(
        census,
        CommentClass::Protected,
        "  ---- protected (never touch) ----",
        collation,
    )?);
    Ok(lines.join("\n"))
}
fn scope_line(scope: &CommentScopeRow) -> String {
    format!(
        "  {}{}{}{}{}",
        pad_end(&scope.scope, 38),
        pad_start(&grouped(scope.comment_lines), 9),
        pad_start(&grouped(scope.code_lines), 9),
        pad_start(&pct(scope.ratio), 8),
        pad_start(&grouped(scope.mechanical_lines), 11)
    )
}
fn scope_table(census: &CommentCensus) -> String {
    let mut lines = vec![format!(
        "  {}{}{}{}{}",
        pad_end("scope", 38),
        pad_start("comments", 9),
        pad_start("code", 9),
        pad_start("ratio", 8),
        pad_start("mechanical", 11)
    )];
    let shown = census
        .scopes
        .iter()
        .take(HUMAN_SCOPE_LIMIT)
        .map(scope_line)
        .collect::<Vec<_>>();
    let rest = census.scopes.len() - shown.len();
    lines.extend(shown);
    if rest > 0 {
        lines.push(format!(
            "  … and {} more scope(s) (--json for all)",
            grouped(rest)
        ));
    }
    lines.join("\n")
}
fn file_line(row: &CommentFileRow) -> String {
    format!(
        "  {}{}{}  {}",
        pad_start(&grouped(row.comment_lines), 8),
        pad_start(&pct(row.ratio), 9),
        pad_start(&grouped(row.mechanical_lines), 12),
        row.file
    )
}
fn file_table(census: &CommentCensus) -> String {
    let shown = census
        .files
        .iter()
        .take(HUMAN_FILE_LIMIT)
        .collect::<Vec<_>>();
    if shown.is_empty() {
        return "no files in scope.".into();
    }
    let mut lines = vec![
        format!(
            "top {} files by comment lines (of {})",
            shown.len(),
            grouped(census.files.len())
        ),
        format!(
            "  {}{}{}  file",
            pad_start("comments", 8),
            pad_start("ratio", 9),
            pad_start("mechanical", 12)
        ),
    ];
    lines.extend(shown.into_iter().map(file_line));
    lines.join("\n")
}
#[derive(Debug)]
pub enum CommentRenderError {
    Collation(CollationError),
    Json(serde_json::Error),
}
impl std::fmt::Display for CommentRenderError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Collation(error) => error.fmt(f),
            Self::Json(error) => error.fmt(f),
        }
    }
}
impl std::error::Error for CommentRenderError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        Some(match self {
            Self::Collation(error) => error,
            Self::Json(error) => error,
        })
    }
}
pub fn render_comments(
    census: &CommentCensus,
    json: bool,
    pretty: bool,
    collation: &Collation,
) -> Result<String, CommentRenderError> {
    if json {
        return stable_stringify(census, pretty).map_err(CommentRenderError::Json);
    }
    let totals = &census.totals;
    Ok([
        format!(
            "comment census: {} comment lines / {} code lines ({}) over {} files",
            grouped(totals.comment_lines),
            grouped(totals.code_lines),
            pct(totals.ratio),
            grouped(totals.files)
        ),
        format!(
            "  {} mechanically cuttable · {} protected · {} prose",
            grouped(totals.mechanical_lines),
            grouped(totals.protected_lines),
            grouped(totals.prose_lines)
        ),
        String::new(),
        bucket_table(census, collation).map_err(CommentRenderError::Collation)?,
        String::new(),
        scope_table(census),
        String::new(),
        file_table(census),
    ]
    .join("\n"))
}
