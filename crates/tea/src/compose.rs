//! Pure composition over typed native values. A host owns its field-replacement
//! method; a read owns its fallible callback and captured context. No model,
//! payload, command or error needs Clone, serialization, Send or a static lifetime.
//!
//! Native closures use explicit captures, without an implicit JavaScript method
//! receiver. The supplied iterator owns live-versus-snapshot iteration semantics.
//! Moving a Vec preserves its allocation and elements; it is not a shared mutable
//! JavaScript array. Typed field replacement does not reflect JS record spread,
//! getters, descriptors, symbols or prototypes.
use crate::{Step, data::JsText};
use std::{borrow::Borrow, convert::Infallible};

/// Rebuild the host through its field-owner method and move the command Vec
/// unchanged. The caller's method owns the one-field/sibling-retention contract.
pub fn lift_slice<H, L, C>(
    host: H,
    step: Step<L, C>,
    replace: impl FnOnce(H, L) -> H,
) -> Step<H, C> {
    Step::new(replace(host, step.state), step.commands)
}

/// One authored read. None defers; Some answers, including falsy/null-like values.
/// Err preserves the caller's original failure. The input loan is independent of
/// the callback environment so returned values may borrow the original input.
/// Ok-only readers need a type hint: annotate `ReadStep`'s domain types
/// (default error `Infallible`) or use `Ok::<_, Infallible>`.
pub struct ReadStep<'env, 'input, I: ?Sized, O, E = Infallible> {
    pub name: JsText,
    pub read: Box<dyn Fn(&'input I) -> Result<Option<O>, E> + 'env>,
}

/// Read left to right, stopping at the first answer or original error. Names are
/// retained data and are not consulted. No callback panic is caught or decorated.
/// Iterators over mutable storage should yield owners after releasing guards.
/// An empty iterator needs a declared item type.
pub fn read_in_order<'env, 'input, I: ?Sized, O, E, T>(
    input: &'input I,
    order: impl IntoIterator<Item = T>,
    absent: O,
) -> Result<O, E>
where
    T: Borrow<ReadStep<'env, 'input, I, O, E>>,
{
    for step in order {
        if let Some(answer) = (step.borrow().read)(input)? {
            return Ok(answer);
        }
    }
    Ok(absent)
}
