// Source comparator, key validation and final row move remain at their owner.
// The shared pinned V8 schedule and its license live in text/v8_sort.rs.
use super::ScopeCountViolation;
use crate::project::{Collation, CollationError, CollationInput};
use std::cmp::Ordering;

pub(super) fn sort(
    rows: &mut [ScopeCountViolation],
    collation: &Collation,
) -> Result<(), CollationError> {
    let inputs = rows
        .iter()
        .map(|row| CollationInput::from_utf16(row.scope.units()))
        .collect::<Result<Vec<_>, _>>()?;
    if rows.len() < 2 {
        return Ok(());
    }
    let order = crate::text::v8_sort::permutation(rows.len(), |left, right| {
        rows[right]
            .delta
            .abs()
            .partial_cmp(&rows[left].delta.abs())
            .unwrap_or(Ordering::Equal)
            .then_with(|| collation.compare(&inputs[left], &inputs[right]))
    });
    let mut destinations = vec![0; rows.len()];
    for (destination, source) in order.into_iter().enumerate() {
        destinations[source] = destination;
    }
    for index in 0..rows.len() {
        while destinations[index] != index {
            let destination = destinations[index];
            rows.swap(index, destination);
            destinations.swap(index, destination);
        }
    }
    Ok(())
}
