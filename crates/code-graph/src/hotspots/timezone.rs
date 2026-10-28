//! One caller-owned ICU77 timezone. This does not reuse or alter Collation.
use crate::text::JsString;
use std::{
    error::Error,
    ffi::{CStr, c_char, c_void},
    fmt,
    ptr::NonNull,
    str::Utf8Error,
};

unsafe extern "C" {
    fn demlik_icu77_timezone_open(
        id: *const u16,
        length: i32,
        use_default: bool,
        error: *mut i32,
    ) -> *mut c_void;
    fn demlik_icu77_timezone_close(zone: *mut c_void);
    fn demlik_icu77_timezone_id(
        zone: *const c_void,
        output: *mut u16,
        capacity: i32,
        error: *mut i32,
    ) -> i32;
    fn demlik_icu77_timezone_local_offset(
        zone: *const c_void,
        local_ms: f64,
        error: *mut i32,
    ) -> i64;
    fn demlik_icu77_timezone_data_version(error: *mut i32) -> *const c_char;
}

#[derive(Debug)]
pub struct TimeZoneIcuError {
    pub operation: &'static str,
    pub code: i32,
}
impl fmt::Display for TimeZoneIcuError {
    fn fmt(&self, out: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(
            out,
            "ICU77 timezone {} failed with status {}",
            self.operation, self.code
        )
    }
}
impl Error for TimeZoneIcuError {}

#[derive(Debug)]
pub enum TimeZoneError {
    InputTooLong { units: usize, maximum: usize },
    Icu(TimeZoneIcuError),
    MissingHandle,
    InvalidIdLength { length: i32 },
    MissingDataVersion,
    DataVersionEncoding(Utf8Error),
}
impl fmt::Display for TimeZoneError {
    fn fmt(&self, out: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::InputTooLong { units, maximum } => write!(
                out,
                "timezone ID has {units} UTF16 units; maximum is {maximum}"
            ),
            Self::Icu(source) => source.fmt(out),
            Self::MissingHandle => out.write_str("ICU77 timezone factory returned no handle"),
            Self::InvalidIdLength { length } => {
                write!(out, "ICU77 returned invalid timezone ID length {length}")
            }
            Self::MissingDataVersion => out.write_str("ICU77 returned no timezone-data version"),
            Self::DataVersionEncoding(source) => {
                write!(out, "ICU77 timezone-data version is not UTF8: {source}")
            }
        }
    }
}
impl Error for TimeZoneError {
    fn source(&self) -> Option<&(dyn Error + 'static)> {
        match self {
            Self::Icu(source) => Some(source),
            Self::DataVersionEncoding(source) => Some(source),
            _ => None,
        }
    }
}
fn checked(operation: &'static str, code: i32) -> Result<(), TimeZoneError> {
    if code > 0 {
        Err(TimeZoneError::Icu(TimeZoneIcuError { operation, code }))
    } else {
        Ok(())
    }
}

/// A local native handle with its actual resolved ID and data-version facts.
/// Node22 uses TZ data2025b; the pinned ICU77 release data is2025a. Successful
/// finite comparisons do not establish general equivalence between those datasets.
#[derive(Debug)]
pub struct LocalTimeZone {
    handle: NonNull<c_void>,
    id: JsString,
    data_version: String,
}
impl Drop for LocalTimeZone {
    fn drop(&mut self) {
        // SAFETY: the successful ICU factory transferred this one handle to us.
        unsafe { demlik_icu77_timezone_close(self.handle.as_ptr()) };
    }
}
impl LocalTimeZone {
    /// Use ICU's existing lazy host default, as Node22's ICUTimezoneCache does.
    pub fn try_default() -> Result<Self, TimeZoneError> {
        Self::open(None)
    }

    /// ICU's named factory includes custom GMT IDs and its zero-offset
    /// Etc/Unknown fallback. Unknown names are not changed into native refusals.
    pub fn try_named(id: &JsString) -> Result<Self, TimeZoneError> {
        Self::open(Some(id))
    }

    fn open(id: Option<&JsString>) -> Result<Self, TimeZoneError> {
        let units = id.map_or(&[][..], JsString::units);
        let length = i32::try_from(units.len()).map_err(|_| TimeZoneError::InputTooLong {
            units: units.len(),
            maximum: i32::MAX as usize,
        })?;
        let mut status = 0;
        // SAFETY: units lives through this call; checked length describes it.
        // The bridge copies the ID and returns an independently owned handle.
        let raw = unsafe {
            demlik_icu77_timezone_open(units.as_ptr(), length, id.is_none(), &mut status)
        };
        checked("open", status)?;
        let handle = NonNull::new(raw).ok_or(TimeZoneError::MissingHandle)?;
        let mut zone = Self {
            handle,
            id: JsString::default(),
            data_version: String::new(),
        };
        let mut status = 0;
        // SAFETY: the handle is live. Zero capacity probes the exact ID length;
        // the bridge does not dereference output when capacity is too small.
        let length = unsafe {
            demlik_icu77_timezone_id(handle.as_ptr(), std::ptr::null_mut(), 0, &mut status)
        };
        // U_BUFFER_OVERFLOW_ERROR is the documented size-probe response.
        if status != rust_icu_sys::UErrorCode::U_BUFFER_OVERFLOW_ERROR as i32 {
            checked("id-length", status)?;
        }
        let length =
            usize::try_from(length).map_err(|_| TimeZoneError::InvalidIdLength { length })?;
        let mut id = vec![0; length];
        status = 0;
        // SAFETY: id has the exact checked capacity from the same live handle.
        let written = unsafe {
            demlik_icu77_timezone_id(handle.as_ptr(), id.as_mut_ptr(), length as i32, &mut status)
        };
        checked("id", status)?;
        if usize::try_from(written).ok() != Some(length) {
            return Err(TimeZoneError::InvalidIdLength { length: written });
        }
        zone.id = JsString::from_units(id);
        status = 0;
        // SAFETY: ICU returns an immutable NUL-terminated version in its loaded
        // static data. It outlives this call and is copied before returning.
        let version = unsafe { demlik_icu77_timezone_data_version(&mut status) };
        checked("data-version", status)?;
        if version.is_null() {
            return Err(TimeZoneError::MissingDataVersion);
        }
        zone.data_version = unsafe { CStr::from_ptr(version) }
            .to_str()
            .map_err(TimeZoneError::DataVersionEncoding)?
            .to_owned();
        Ok(zone)
    }
    pub fn id(&self) -> &JsString {
        &self.id
    }
    pub fn data_version(&self) -> &str {
        &self.data_version
    }

    pub(super) fn local_offset(&self, local_ms: f64) -> Result<f64, TimeZoneError> {
        let mut status = 0;
        // SAFETY: this caller-owned handle is live. The only caller first
        // validates V8's finite maxBeforeUTC range; no input pointer escapes.
        let offset = unsafe {
            demlik_icu77_timezone_local_offset(self.handle.as_ptr(), local_ms, &mut status)
        };
        checked("local-offset", status)?;
        Ok(offset as f64)
    }
}
