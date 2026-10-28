use super::{
    ChurnWindow,
    date::{self, MS_PER_DAY},
    timezone::{LocalTimeZone, TimeZoneError},
};
use crate::{number::js_round, text::JsString};
use std::{
    error::Error,
    fmt,
    time::{SystemTime, UNIX_EPOCH},
};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WindowDate {
    Since,
    Until,
}
#[derive(Debug)]
pub struct InvalidTimeValue {
    pub part: WindowDate,
    pub value: f64,
    pub since_input: Option<JsString>,
}
impl fmt::Display for InvalidTimeValue {
    fn fmt(&self, out: &mut fmt::Formatter<'_>) -> fmt::Result {
        out.write_str("Invalid time value")
    }
}
impl Error for InvalidTimeValue {}
#[derive(Debug)]
pub enum ChurnWindowError {
    InvalidTimeValue(InvalidTimeValue),
    TimeZone(TimeZoneError),
}
impl ChurnWindowError {
    pub fn name(&self) -> &'static str {
        match self {
            Self::InvalidTimeValue(_) => "RangeError",
            Self::TimeZone(_) => "Error",
        }
    }
    pub fn message(&self) -> JsString {
        self.to_string().into()
    }
}
impl fmt::Display for ChurnWindowError {
    fn fmt(&self, out: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::InvalidTimeValue(source) => source.fmt(out),
            Self::TimeZone(source) => source.fmt(out),
        }
    }
}
impl Error for ChurnWindowError {
    fn source(&self) -> Option<&(dyn Error + 'static)> {
        Some(match self {
            Self::InvalidTimeValue(source) => source,
            Self::TimeZone(source) => source,
        })
    }
}

/// Exactly one late clock read. Results own the window and retain neither the
/// borrowed zone nor captured clock. Numeric days remain Source's Number input.
pub fn resolve_churn_window(
    days: f64,
    since: Option<&JsString>,
    read_clock: impl FnOnce() -> f64,
    zone: &LocalTimeZone,
) -> Result<ChurnWindow, ChurnWindowError> {
    resolve_window(days, since, read_clock, |local| zone.local_offset(local))
}

pub(crate) fn system_clock_ms() -> f64 {
    match SystemTime::now().duration_since(UNIX_EPOCH) {
        Ok(value) => value.as_millis() as f64,
        Err(error) => -(error.duration().as_millis() as f64),
    }
}

pub(crate) fn resolve_churn_window_local(
    days: f64,
    since: Option<&JsString>,
    read_clock: impl FnOnce() -> f64,
) -> Result<ChurnWindow, ChurnWindowError> {
    resolve_window(days, since, read_clock, |local| {
        LocalTimeZone::try_default()?.local_offset(local)
    })
}

// The CLI constructs its one zone only if a successfully parsed local date
// reaches V8's maxBeforeUTC guard. Z/offset/date-only/relative/invalid paths do
// not initialize a timezone or observe a host TZ at all.
fn resolve_window(
    days: f64,
    since: Option<&JsString>,
    read_clock: impl FnOnce() -> f64,
    local_offset: impl FnOnce(f64) -> Result<f64, TimeZoneError>,
) -> Result<ChurnWindow, ChurnWindowError> {
    let until = date::time_clip(read_clock());
    let since_value = match since {
        Some(input) => date::parse_date(input, local_offset).map_err(ChurnWindowError::TimeZone)?,
        None => date::time_clip(until - days * MS_PER_DAY),
    };
    let span = js_round((until - since_value) / MS_PER_DAY);
    let span = if span.is_nan() {
        span
    } else if span <= 0.0 {
        0.0
    } else {
        span
    };
    let invalid = |part, value| {
        ChurnWindowError::InvalidTimeValue(InvalidTimeValue {
            part,
            value,
            since_input: since.cloned(),
        })
    };
    // Object-literal evaluation in Source formats since before until.
    let since_iso =
        date::iso_string(since_value).ok_or_else(|| invalid(WindowDate::Since, since_value))?;
    let until_iso = date::iso_string(until).ok_or_else(|| invalid(WindowDate::Until, until))?;
    Ok(ChurnWindow {
        since_iso,
        until_iso,
        days: span,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::Cell;

    #[test]
    fn clock_is_once_and_nonlocal_or_invalid_dates_do_not_request_a_zone() {
        for (days, input, valid) in [
            (90.0, None, true),
            (f64::INFINITY, Some("2026-10-01T00:00:00Z"), true),
            (90.0, Some("2026-10-01T12:30:45+05:30"), true),
            (90.0, Some("2026-10-01"), true),
            (90.0, Some("not-a-date"), false),
            (90.0, Some("+999999-01-01T00:00:00"), false),
            (f64::INFINITY, None, false),
        ] {
            let reads = Cell::new(0);
            let input = input.map(JsString::from);
            let result = resolve_window(
                days,
                input.as_ref(),
                || {
                    reads.set(reads.get() + 1);
                    1_793_102_400_123.75
                },
                |_| panic!("no local-to-UTC operation for this input"),
            );
            assert_eq!(reads.get(), 1);
            assert_eq!(result.is_ok(), valid);
        }
    }

    #[test]
    fn local_zone_failure_stays_the_original_typed_cause() {
        let input = JsString::from("2026-03-08T02:30:00");
        let calls = Cell::new(0);
        let error = resolve_window(
            90.0,
            Some(&input),
            || 0.0,
            |local| {
                calls.set(calls.get() + 1);
                assert_eq!(local, 1_772_937_000_000.0);
                Err(TimeZoneError::Icu(
                    super::super::timezone::TimeZoneIcuError {
                        operation: "local-offset",
                        code: 3,
                    },
                ))
            },
        )
        .unwrap_err();
        assert_eq!(calls.get(), 1);
        let ChurnWindowError::TimeZone(original) = &error else {
            panic!("timezone error")
        };
        assert!(std::ptr::eq(
            error
                .source()
                .unwrap()
                .downcast_ref::<TimeZoneError>()
                .unwrap(),
            original
        ));
    }

    #[test]
    fn invalid_since_formats_before_invalid_until() {
        let error = resolve_window(
            90.0,
            Some(&JsString::from("not-a-date")),
            || f64::NAN,
            |_| panic!("invalid parse does not request a zone"),
        )
        .unwrap_err();
        let ChurnWindowError::InvalidTimeValue(error) = error else {
            panic!("invalid date")
        };
        assert_eq!(error.part, WindowDate::Since);
        assert!(error.value.is_nan());
        assert_eq!(error.since_input.unwrap(), "not-a-date");
    }
}
