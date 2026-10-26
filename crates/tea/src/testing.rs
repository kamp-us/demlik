//! Pure test helpers over the existing replay and update owners.
//!
//! Comparisons belong to the caller: these helpers do not supply JavaScript
//! deep equality, Vitest diagnostics, or development freeze/field inspection.
//! The last distinction applies to `step` and to replays that apply messages.
use crate::{Machine, NoCellError, Replay, Step, Subscription, Tagged, core};

pub struct ReplayOpts<S, I> {
    pub loaded: Option<S>,
    pub msgs: I,
}

#[derive(Debug)]
pub enum CheckError<E> {
    Replay(NoCellError),
    Matcher(E),
    FinalStateMismatch,
    CmdNotEmitted,
    CmdSequenceLength { actual: usize, expected: usize },
    CmdSequenceItem { index: usize },
    ActiveSubsLength { actual: usize, expected: usize },
    ActiveSubsItem { index: usize },
}

/// Borrow the machine and context once. Matchers are supplied to each assertion
/// and are never retained. Owning an iterator or loaded state requires no Clone.
pub struct BoundMachine<'b, 'a, S, M, C, U, X> {
    machine: &'b Machine<'a, S, M, C, U, X>,
    input: &'b X,
}
pub fn bind_machine<'b, 'a, S, M, C, U, X>(
    machine: &'b Machine<'a, S, M, C, U, X>,
    input: &'b X,
) -> BoundMachine<'b, 'a, S, M, C, U, X> {
    BoundMachine { machine, input }
}

/// Apply one message to the supplied state. Init, context and subscription
/// projection are not read; existing refusal and panic payloads propagate.
pub fn step<S: Tagged, M: Tagged, C, U, X>(
    machine: &Machine<'_, S, M, C, U, X>,
    state: &S,
    msg: &M,
    _input: &X,
) -> Result<Step<S, C>, NoCellError> {
    machine.update.apply(state, msg)
}
impl<S: Tagged, M: Tagged, C, U, X> BoundMachine<'_, '_, S, M, C, U, X> {
    pub fn step(&self, state: &S, msg: &M) -> Result<Step<S, C>, NoCellError> {
        step(self.machine, state, msg, self.input)
    }
}

/// Complete one full replay before comparing the final state once. A callback
/// error is retained unchanged; a callback panic is not caught.
pub fn expect_final_state<S: Tagged, M: Tagged, C, U: Subscription, X, I, E>(
    machine: &Machine<'_, S, M, C, U, X>,
    input: &X,
    opts: ReplayOpts<S, I>,
    expected: &S,
    equal: impl FnOnce(&S, &S) -> Result<bool, E>,
) -> Result<(), CheckError<E>>
where
    I: IntoIterator<Item = M>,
{
    let replay =
        core::replay(machine, opts.loaded, input, opts.msgs).map_err(CheckError::Replay)?;
    if equal(&replay.state, expected).map_err(CheckError::Matcher)? {
        Ok(())
    } else {
        Err(CheckError::FinalStateMismatch)
    }
}

/// Search emitted commands in order, stopping at the first match or callback
/// error. Surrounding commands do not affect containment. Replay always finishes
/// first, even if an early command would match.
pub fn expect_cmd_emitted<S: Tagged, M: Tagged, C, U: Subscription, X, I, E>(
    machine: &Machine<'_, S, M, C, U, X>,
    input: &X,
    opts: ReplayOpts<S, I>,
    expected: &C,
    mut equal: impl FnMut(&C, &C) -> Result<bool, E>,
) -> Result<(), CheckError<E>>
where
    I: IntoIterator<Item = M>,
{
    let replay =
        core::replay(machine, opts.loaded, input, opts.msgs).map_err(CheckError::Replay)?;
    for command in &replay.commands {
        if equal(command, expected).map_err(CheckError::Matcher)? {
            return Ok(());
        }
    }
    Err(CheckError::CmdNotEmitted)
}

#[derive(Clone, Copy)]
enum Sequence {
    Commands,
    Subs,
}
impl Sequence {
    fn length<E>(self, actual: usize, expected: usize) -> CheckError<E> {
        match self {
            Self::Commands => CheckError::CmdSequenceLength { actual, expected },
            Self::Subs => CheckError::ActiveSubsLength { actual, expected },
        }
    }
    fn item<E>(self, index: usize) -> CheckError<E> {
        match self {
            Self::Commands => CheckError::CmdSequenceItem { index },
            Self::Subs => CheckError::ActiveSubsItem { index },
        }
    }
}
fn compare_sequence<T, E>(
    sequence: Sequence,
    actual: &[T],
    expected: &[T],
    mut equal: impl FnMut(&T, &T) -> Result<bool, E>,
) -> Result<(), CheckError<E>> {
    if actual.len() != expected.len() {
        return Err(sequence.length(actual.len(), expected.len()));
    }
    for (index, (a, b)) in actual.iter().zip(expected).enumerate() {
        if !equal(a, b).map_err(CheckError::Matcher)? {
            return Err(sequence.item(index));
        }
    }
    Ok(())
}

/// Compare exact command length and order after replay. Unequal lengths make no
/// callback calls; equal lengths compare pairs until the first mismatch/error.
pub fn expect_cmd_sequence<S: Tagged, M: Tagged, C, U: Subscription, X, I, E>(
    machine: &Machine<'_, S, M, C, U, X>,
    input: &X,
    opts: ReplayOpts<S, I>,
    expected: &[C],
    equal: impl FnMut(&C, &C) -> Result<bool, E>,
) -> Result<(), CheckError<E>>
where
    I: IntoIterator<Item = M>,
{
    let replay =
        core::replay(machine, opts.loaded, input, opts.msgs).map_err(CheckError::Replay)?;
    compare_sequence(Sequence::Commands, &replay.commands, expected, equal)
}

/// Compare the final desired subscription array with exact length and order.
/// Core replay owns projection and first-ID deduplication; no runner starts.
pub fn expect_active_subs<S: Tagged, M: Tagged, C, U: Subscription, X, I, E>(
    machine: &Machine<'_, S, M, C, U, X>,
    input: &X,
    opts: ReplayOpts<S, I>,
    expected: &[U],
    equal: impl FnMut(&U, &U) -> Result<bool, E>,
) -> Result<(), CheckError<E>>
where
    I: IntoIterator<Item = M>,
{
    let replay =
        core::replay(machine, opts.loaded, input, opts.msgs).map_err(CheckError::Replay)?;
    compare_sequence(Sequence::Subs, &replay.subs, expected, equal)
}

impl<S: Tagged, M: Tagged, C, U: Subscription, X> BoundMachine<'_, '_, S, M, C, U, X> {
    pub fn replay<I: IntoIterator<Item = M>>(
        &self,
        opts: ReplayOpts<S, I>,
    ) -> Result<Replay<S, C, U>, NoCellError> {
        core::replay(self.machine, opts.loaded, self.input, opts.msgs)
    }
    pub fn expect_final_state<I: IntoIterator<Item = M>, E>(
        &self,
        opts: ReplayOpts<S, I>,
        expected: &S,
        equal: impl FnOnce(&S, &S) -> Result<bool, E>,
    ) -> Result<(), CheckError<E>> {
        expect_final_state(self.machine, self.input, opts, expected, equal)
    }
    pub fn expect_cmd_emitted<I: IntoIterator<Item = M>, E>(
        &self,
        opts: ReplayOpts<S, I>,
        expected: &C,
        equal: impl FnMut(&C, &C) -> Result<bool, E>,
    ) -> Result<(), CheckError<E>> {
        expect_cmd_emitted(self.machine, self.input, opts, expected, equal)
    }
    pub fn expect_cmd_sequence<I: IntoIterator<Item = M>, E>(
        &self,
        opts: ReplayOpts<S, I>,
        expected: &[C],
        equal: impl FnMut(&C, &C) -> Result<bool, E>,
    ) -> Result<(), CheckError<E>> {
        expect_cmd_sequence(self.machine, self.input, opts, expected, equal)
    }
    pub fn expect_active_subs<I: IntoIterator<Item = M>, E>(
        &self,
        opts: ReplayOpts<S, I>,
        expected: &[U],
        equal: impl FnMut(&U, &U) -> Result<bool, E>,
    ) -> Result<(), CheckError<E>> {
        expect_active_subs(self.machine, self.input, opts, expected, equal)
    }
}
