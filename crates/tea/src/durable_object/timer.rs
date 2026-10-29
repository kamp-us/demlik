use super::AlarmStorage;
use std::{fmt, future::Future};

/// A timer failure retains the original cause and the phase that failed.
#[derive(Debug)]
pub enum DurableTimerError<A, D, F> {
    Fire(F),
    Deadline(D),
    Alarm(A),
}
impl<A: fmt::Display, D: fmt::Display, F: fmt::Display> fmt::Display
    for DurableTimerError<A, D, F>
{
    fn fmt(&self, output: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Fire(cause) => write!(output, "timer fire: {cause}"),
            Self::Deadline(cause) => write!(output, "timer deadline: {cause}"),
            Self::Alarm(cause) => write!(output, "timer alarm: {cause}"),
        }
    }
}
impl<A: std::error::Error + 'static, D: std::error::Error + 'static, F: std::error::Error + 'static>
    std::error::Error for DurableTimerError<A, D, F>
{
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        Some(match self {
            Self::Fire(cause) => cause,
            Self::Deadline(cause) => cause,
            Self::Alarm(cause) => cause,
        })
    }
}

/// Alarm host adapter. The persisted consumer state owns the schedule.
/// Operations progress when their futures are polled; creating or dropping an
/// unpolled future does not execute the eager JavaScript Promise workflow.
pub struct DurableTimer<A, D, F> {
    alarm: A,
    next_deadline: D,
    on_fire: F,
}
pub fn durable_timer<A, D, F>(alarm: A, next_deadline: D, on_fire: F) -> DurableTimer<A, D, F> {
    DurableTimer {
        alarm,
        next_deadline,
        on_fire,
    }
}
impl<A: AlarmStorage, D, F, DF, FF, DE, FE> DurableTimer<A, D, F>
where
    D: Fn() -> DF,
    F: Fn() -> FF,
    DF: Future<Output = Result<Option<f64>, DE>>,
    FF: Future<Output = Result<(), FE>>,
{
    /// Recompute an absolute epoch-ms target. None makes no alarm call.
    pub async fn rearm(&self) -> Result<(), DurableTimerError<A::Error, DE, FE>> {
        if let Some(at) = (self.next_deadline)()
            .await
            .map_err(DurableTimerError::Deadline)?
        {
            self.alarm
                .set_alarm(at)
                .await
                .map_err(DurableTimerError::Alarm)?;
        }
        Ok(())
    }
    /// Await the consumer's dispatch and persistence before computing the next target.
    pub async fn on_alarm(&self) -> Result<(), DurableTimerError<A::Error, DE, FE>> {
        (self.on_fire)().await.map_err(DurableTimerError::Fire)?;
        self.rearm().await
    }
}
