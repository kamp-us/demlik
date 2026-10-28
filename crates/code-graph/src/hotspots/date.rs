// Copyright 2011, 2012 the V8 project authors. All rights reserved.
// Adapted from Node v22.21.1 deps/v8/src/date/{dateparser*,date.*} and
// builtins/builtins-date.cc. See V8-DATE-LICENSE and DATE-REFERENCE.md.
// This is only the string/numeric Date behavior used by resolveChurnWindow.
use super::timezone::TimeZoneError;
use crate::text::{JsString, js_space};

pub(super) const MS_PER_DAY: f64 = 86_400_000.0;
const MAX_TIME: f64 = 8_640_000_000_000_000.0;
const MAX_BEFORE_UTC: f64 = MAX_TIME + 30.0 * MS_PER_DAY;

pub(super) fn time_clip(value: f64) -> f64 {
    if (-MAX_TIME..=MAX_TIME).contains(&value) {
        value.trunc() + 0.0
    } else {
        f64::NAN
    }
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Keyword {
    Invalid,
    Month,
    Zone,
    Separator,
    AmPm,
}
#[derive(Clone, Copy)]
enum Token {
    Invalid,
    Unknown,
    WhiteSpace,
    Number {
        value: i32,
        length: usize,
    },
    Symbol(u16),
    End,
    Word {
        kind: Keyword,
        value: i32,
        length: usize,
    },
}
impl Token {
    fn symbol(self, symbol: u8) -> bool {
        matches!(self, Self::Symbol(c) if c == u16::from(symbol))
    }
    fn sign(self) -> Option<i32> {
        if self.symbol(b'+') {
            Some(1)
        } else if self.symbol(b'-') {
            Some(-1)
        } else {
            None
        }
    }
    fn number(self) -> Option<i32> {
        if let Self::Number { value, .. } = self {
            Some(value)
        } else {
            None
        }
    }
    fn fixed_number(self, length: usize) -> Option<i32> {
        if let Self::Number {
            value,
            length: actual,
        } = self
        {
            (length == actual).then_some(value)
        } else {
            None
        }
    }
    fn z(self) -> bool {
        matches!(
            self,
            Self::Word {
                kind: Keyword::Zone,
                value: 0,
                length: 1
            }
        )
    }
}
struct Scanner<'a> {
    units: &'a [u16],
    position: usize,
    peek: Token,
}
impl<'a> Scanner<'a> {
    fn new(units: &'a [u16]) -> Self {
        let mut scanner = Self {
            units,
            position: 0,
            peek: Token::End,
        };
        scanner.peek = scanner.scan();
        scanner
    }
    fn current(&self) -> u16 {
        self.units.get(self.position).copied().unwrap_or(0)
    }
    fn next(&mut self) -> Token {
        let token = self.peek;
        self.peek = self.scan();
        token
    }
    fn skip(&mut self, symbol: u8) -> bool {
        if self.peek.symbol(symbol) {
            self.next();
            true
        } else {
            false
        }
    }
    fn scan(&mut self) -> Token {
        let c = self.current();
        if c == 0 {
            return Token::End;
        }
        let start = self.position;
        if (48..=57).contains(&c) {
            while self.current() == 48 {
                self.position += 1;
            }
            let mut value = 0;
            let mut digits = 0;
            while (48..=57).contains(&self.current()) {
                if digits < 9 {
                    value = value * 10 + i32::from(self.current() - 48);
                }
                digits += 1;
                self.position += 1;
            }
            return Token::Number {
                value,
                length: self.position - start,
            };
        }
        if [b':', b'-', b'+', b'.', b')'].map(u16::from).contains(&c) {
            self.position += 1;
            return Token::Symbol(c);
        }
        if c >= 65 && !white_space(c) {
            let mut prefix = [0; 3];
            while self.current() >= 65 && !white_space(self.current()) {
                let index = self.position - start;
                if index < 3 {
                    prefix[index] = self.current() | 0x20;
                }
                self.position += 1;
            }
            let length = self.position - start;
            let (kind, value) = keyword(prefix, length);
            return Token::Word {
                kind,
                value,
                length,
            };
        }
        if space_or_line(c) {
            self.position += 1;
            return Token::WhiteSpace;
        }
        if c == 40 {
            let mut balance = 0;
            loop {
                match self.current() {
                    40 => balance += 1,
                    41 => balance -= 1,
                    _ => {}
                }
                self.position += 1;
                if balance <= 0 || self.current() == 0 {
                    break;
                }
            }
            return Token::Unknown;
        }
        self.position += 1;
        Token::Unknown
    }
}
fn space_or_line(c: u16) -> bool {
    char::from_u32(u32::from(c)).is_some_and(js_space)
}
fn white_space(c: u16) -> bool {
    space_or_line(c) && !matches!(c, 10 | 13 | 0x2028 | 0x2029)
}
fn keyword(prefix: [u16; 3], length: usize) -> (Keyword, i32) {
    const TABLE: [([u8; 3], Keyword, i32); 27] = [
        (*b"jan", Keyword::Month, 1),
        (*b"feb", Keyword::Month, 2),
        (*b"mar", Keyword::Month, 3),
        (*b"apr", Keyword::Month, 4),
        (*b"may", Keyword::Month, 5),
        (*b"jun", Keyword::Month, 6),
        (*b"jul", Keyword::Month, 7),
        (*b"aug", Keyword::Month, 8),
        (*b"sep", Keyword::Month, 9),
        (*b"oct", Keyword::Month, 10),
        (*b"nov", Keyword::Month, 11),
        (*b"dec", Keyword::Month, 12),
        (*b"am\0", Keyword::AmPm, 0),
        (*b"pm\0", Keyword::AmPm, 12),
        (*b"ut\0", Keyword::Zone, 0),
        (*b"utc", Keyword::Zone, 0),
        (*b"z\0\0", Keyword::Zone, 0),
        (*b"gmt", Keyword::Zone, 0),
        (*b"cdt", Keyword::Zone, -5),
        (*b"cst", Keyword::Zone, -6),
        (*b"edt", Keyword::Zone, -4),
        (*b"est", Keyword::Zone, -5),
        (*b"mdt", Keyword::Zone, -6),
        (*b"mst", Keyword::Zone, -7),
        (*b"pdt", Keyword::Zone, -7),
        (*b"pst", Keyword::Zone, -8),
        (*b"t\0\0", Keyword::Separator, 0),
    ];
    TABLE
        .into_iter()
        .find(|(key, kind, _)| {
            key.map(u16::from) == prefix && (length <= 3 || *kind == Keyword::Month)
        })
        .map_or((Keyword::Invalid, 0), |(_, kind, value)| (kind, value))
}

#[derive(Default)]
struct Day {
    components: [i32; 3],
    length: usize,
    named_month: Option<i32>,
    iso: bool,
}
impl Day {
    fn add(&mut self, value: i32) -> bool {
        if self.length == 3 {
            return false;
        }
        self.components[self.length] = value;
        self.length += 1;
        true
    }
    fn write(&mut self) -> Option<(i32, i32, i32)> {
        if self.length == 0 {
            return None;
        }
        while self.length < 3 {
            self.add(1);
        }
        let [a, b, c] = self.components;
        let (mut year, month, day) = match self.named_month {
            None if self.iso || (self.length == 3 && !is_day(a)) => (a, b, c),
            None => (if self.length == 3 { c } else { 0 }, a, b),
            Some(month) if self.length == 1 => (0, month, a),
            Some(month) if !is_day(a) => (a, month, b),
            Some(month) => (b, month, a),
        };
        if !self.iso {
            if (0..=49).contains(&year) {
                year += 2000;
            } else if (50..=99).contains(&year) {
                year += 1900;
            }
        }
        (is_month(month) && is_day(day)).then_some((year, month - 1, day))
    }
}
#[derive(Default)]
struct Time {
    components: [i32; 4],
    length: usize,
    hour_offset: Option<i32>,
}
impl Time {
    fn add(&mut self, value: i32) -> bool {
        if self.length == 4 {
            return false;
        }
        self.components[self.length] = value;
        self.length += 1;
        true
    }
    fn add_final(&mut self, value: i32) -> bool {
        if !self.add(value) {
            return false;
        }
        while self.length < 4 {
            self.add(0);
        }
        true
    }
    fn expecting(&self, value: i32) -> bool {
        match self.length {
            1 | 2 => is_minute(value),
            3 => (0..=999).contains(&value),
            _ => false,
        }
    }
    fn write(&mut self) -> Option<[i32; 4]> {
        while self.length < 4 {
            self.add(0);
        }
        let [mut hour, minute, second, ms] = self.components;
        if let Some(offset) = self.hour_offset {
            if !(0..=12).contains(&hour) {
                return None;
            }
            hour = hour % 12 + offset;
        }
        if !(is_hour(hour) && is_minute(minute) && is_minute(second) && (0..=999).contains(&ms))
            && !(hour == 24 && minute == 0 && second == 0 && ms == 0)
        {
            return None;
        }
        Some([hour, minute, second, ms])
    }
}
#[derive(Default)]
struct Zone {
    sign: Option<i32>,
    hour: Option<i32>,
    minute: Option<i32>,
}
impl Zone {
    fn set(&mut self, hours: i32) {
        let sign = if hours < 0 { -1 } else { 1 };
        self.sign = Some(sign);
        self.hour = Some(hours * sign);
        self.minute = Some(0);
    }
    fn expecting(&self, value: i32) -> bool {
        self.hour.is_some() && self.minute.is_none() && is_minute(value)
    }
    fn utc(&self) -> bool {
        self.hour == Some(0) && self.minute == Some(0)
    }
    fn write(&self) -> Option<Option<i32>> {
        let Some(sign) = self.sign else {
            return Some(None);
        };
        // Exact pinned Node22 build has 32-bit Smis. The original composer uses
        // wrapping unsigned arithmetic before checking Smi::kMaxValue.
        let seconds = (self.hour.unwrap_or(0) as u32)
            .wrapping_mul(3600)
            .wrapping_add((self.minute.unwrap_or(0) as u32).wrapping_mul(60));
        (seconds <= i32::MAX as u32).then_some(Some((seconds as i32) * sign))
    }
}
fn is_month(value: i32) -> bool {
    (1..=12).contains(&value)
}
fn is_day(value: i32) -> bool {
    (1..=31).contains(&value)
}
fn is_hour(value: i32) -> bool {
    (0..=23).contains(&value)
}
fn is_minute(value: i32) -> bool {
    (0..=59).contains(&value)
}
fn milliseconds(token: Token) -> i32 {
    let Token::Number {
        mut value,
        mut length,
    } = token
    else {
        unreachable!("numeric fraction token")
    };
    if length == 1 {
        value *= 100;
    } else if length == 2 {
        value *= 10;
    } else if length > 3 {
        length = length.min(9);
        let mut factor = 1;
        while length > 3 {
            factor *= 10;
            length -= 1;
        }
        value /= factor;
    }
    value
}

fn iso_prefix(scan: &mut Scanner<'_>, day: &mut Day, time: &mut Time, zone: &mut Zone) -> Token {
    if let Some(sign) = scan.peek.sign() {
        let sign_token = scan.next();
        let Some(year) = scan.peek.fixed_number(6) else {
            return sign_token;
        };
        scan.next();
        if sign < 0 && year == 0 {
            return sign_token;
        }
        day.add(sign * year);
    } else if let Some(year) = scan.peek.fixed_number(4) {
        scan.next();
        day.add(year);
    } else {
        return scan.next();
    }
    if scan.skip(b'-') {
        let Some(month) = scan.peek.fixed_number(2).filter(|&value| is_month(value)) else {
            return scan.next();
        };
        scan.next();
        day.add(month);
        if scan.skip(b'-') {
            let Some(date) = scan.peek.fixed_number(2).filter(|&value| is_day(value)) else {
                return scan.next();
            };
            scan.next();
            day.add(date);
        }
    }
    if !matches!(
        scan.peek,
        Token::Word {
            kind: Keyword::Separator,
            ..
        }
    ) {
        if !matches!(scan.peek, Token::End) {
            return scan.next();
        }
    } else {
        scan.next();
        let Some(hour) = scan
            .peek
            .fixed_number(2)
            .filter(|value| (0..=24).contains(value))
        else {
            return Token::Invalid;
        };
        let hour_24 = hour == 24;
        scan.next();
        time.add(hour);
        if !scan.skip(b':') {
            return Token::Invalid;
        }
        let Some(minute) = scan
            .peek
            .fixed_number(2)
            .filter(|&value| is_minute(value) && (!hour_24 || value == 0))
        else {
            return Token::Invalid;
        };
        scan.next();
        time.add(minute);
        if scan.skip(b':') {
            let Some(second) = scan
                .peek
                .fixed_number(2)
                .filter(|&value| is_minute(value) && (!hour_24 || value == 0))
            else {
                return Token::Invalid;
            };
            scan.next();
            time.add(second);
            if scan.skip(b'.') {
                let Some(value) = scan.peek.number() else {
                    return Token::Invalid;
                };
                if hour_24 && value > 0 {
                    return Token::Invalid;
                }
                time.add(milliseconds(scan.next()));
            }
        }
        if scan.peek.z() {
            scan.next();
            zone.set(0);
        } else if let Some(sign) = scan.peek.sign() {
            scan.next();
            zone.sign = Some(sign);
            if let Some(hhmm) = scan.peek.fixed_number(4) {
                scan.next();
                if !is_hour(hhmm / 100) || !is_minute(hhmm % 100) {
                    return Token::Invalid;
                }
                zone.hour = Some(hhmm / 100);
                zone.minute = Some(hhmm % 100);
            } else {
                let Some(hour) = scan.peek.fixed_number(2).filter(|&value| is_hour(value)) else {
                    return Token::Invalid;
                };
                scan.next();
                zone.hour = Some(hour);
                if !scan.skip(b':') {
                    return Token::Invalid;
                }
                let Some(minute) = scan.peek.fixed_number(2).filter(|&value| is_minute(value))
                else {
                    return Token::Invalid;
                };
                scan.next();
                zone.minute = Some(minute);
            }
        }
        if !matches!(scan.peek, Token::End) {
            return Token::Invalid;
        }
    }
    if zone.hour.is_none() && time.length == 0 {
        zone.set(0);
    }
    day.iso = true;
    Token::End
}

struct Parts {
    year: i32,
    month: i32,
    day: i32,
    time: [i32; 4],
    offset_seconds: Option<i32>,
}
fn parse(units: &[u16]) -> Option<Parts> {
    let mut scan = Scanner::new(units);
    let mut day = Day::default();
    let mut time = Time::default();
    let mut zone = Zone::default();
    let mut token = iso_prefix(&mut scan, &mut day, &mut time, &mut zone);
    if matches!(token, Token::Invalid) {
        return None;
    }
    let mut read_number = day.length != 0;
    while !matches!(token, Token::End) {
        if let Some(n) = token.number() {
            read_number = true;
            if scan.skip(b':') {
                if scan.skip(b':') {
                    if time.length != 0 {
                        return None;
                    }
                    time.add(n);
                    time.add(0);
                } else {
                    if !time.add(n) {
                        return None;
                    }
                    if scan.peek.symbol(b'.') {
                        scan.next();
                    }
                }
            } else if scan.skip(b'.') && time.expecting(n) {
                time.add(n);
                scan.peek.number()?;
                let ms = milliseconds(scan.next());
                time.add_final(ms);
            } else if zone.expecting(n) {
                zone.minute = Some(n);
            } else if time.expecting(n) {
                time.add_final(n);
                if !(matches!(scan.peek, Token::End | Token::WhiteSpace)
                    || scan.peek.z()
                    || scan.peek.sign().is_some())
                {
                    return None;
                }
            } else {
                if !day.add(n) {
                    return None;
                }
                scan.skip(b'-');
            }
        } else if let Token::Word { kind, value, .. } = token {
            if kind == Keyword::AmPm && time.length != 0 {
                time.hour_offset = Some(value);
            } else if kind == Keyword::Month {
                day.named_month = Some(value);
                scan.skip(b'-');
            } else if kind == Keyword::Zone && read_number {
                zone.set(value);
            } else if read_number || scan.peek.number().is_some() {
                return None;
            }
        } else if token.sign().is_some() && (zone.utc() || time.length != 0) {
            zone.sign = token.sign();
            let (n, length) = if let Token::Number { value, length } = scan.peek {
                scan.next();
                (value, length)
            } else {
                (0, 0)
            };
            read_number = true;
            if scan.peek.symbol(b':') {
                zone.hour = Some(n);
                zone.minute = None;
            } else if length == 1 || length == 2 {
                zone.hour = Some(n);
                zone.minute = Some(0);
            } else if length == 3 || length == 4 {
                zone.hour = Some(n / 100);
                zone.minute = Some(n % 100);
            } else {
                return None;
            }
        } else if (token.sign().is_some() || token.symbol(b')')) && read_number {
            return None;
        }
        token = scan.next();
    }
    let (year, month, date) = day.write()?;
    let time = time.write()?;
    let offset_seconds = zone.write()?;
    Some(Parts {
        year,
        month,
        day: date,
        time,
        offset_seconds,
    })
}

fn make_day(year: i32, month: i32, day: i32) -> f64 {
    if !(-1_000_000..=1_000_000).contains(&year) || !(-10_000_000..=10_000_000).contains(&month) {
        return f64::NAN;
    }
    let mut y = i64::from(year) + i64::from(month / 12);
    let mut m = month % 12;
    if m < 0 {
        m += 12;
        y -= 1;
    }
    const DELTA: i64 = 399_999;
    const BASE: i64 =
        365 * (1970 + DELTA) + (1970 + DELTA) / 4 - (1970 + DELTA) / 100 + (1970 + DELTA) / 400;
    let shifted = y + DELTA;
    let mut from_year = 365 * shifted + shifted / 4 - shifted / 100 + shifted / 400 - BASE;
    let leap = y % 4 == 0 && (y % 100 != 0 || y % 400 == 0);
    from_year += if leap {
        [0, 31, 60, 91, 121, 152, 182, 213, 244, 274, 305, 335][m as usize]
    } else {
        [0, 31, 59, 90, 120, 151, 181, 212, 243, 273, 304, 334][m as usize]
    };
    (from_year - 1 + i64::from(day)) as f64
}
pub(super) fn parse_date(
    input: &JsString,
    local_offset: impl FnOnce(f64) -> Result<f64, TimeZoneError>,
) -> Result<f64, TimeZoneError> {
    let Some(parts) = parse(input.units()) else {
        return Ok(f64::NAN);
    };
    let [hour, minute, second, ms] = parts.time.map(f64::from);
    let time = hour * 3_600_000.0 + minute * 60_000.0 + second * 1000.0 + ms;
    let mut date = time + make_day(parts.year, parts.month, parts.day) * MS_PER_DAY;
    if let Some(offset) = parts.offset_seconds {
        date -= f64::from(offset) * 1000.0;
    } else if (-MAX_BEFORE_UTC..=MAX_BEFORE_UTC).contains(&date) {
        // V8's ICU path subtracts this actual local offset directly. The
        // EquivalentTime mapping belongs to the non-ICU DST fallback only.
        date -= local_offset(date.trunc())?;
    } else {
        return Ok(f64::NAN);
    }
    Ok(time_clip(date))
}

pub(super) fn iso_string(value: f64) -> Option<JsString> {
    if !value.is_finite() {
        return None;
    }
    const DAY: i64 = 86_400_000;
    const FOUR_YEARS: i64 = 1461;
    const HUNDRED_YEARS: i64 = 36524;
    const FOUR_HUNDRED_YEARS: i64 = 146097;
    const OFFSET: i64 = 1005 * FOUR_HUNDRED_YEARS - (30 * 365 + 7);
    let integer = value as i64;
    let days = integer.div_euclid(DAY);
    let time = integer - days * DAY;
    let mut remaining = days + OFFSET;
    let mut year = 400 * (remaining / FOUR_HUNDRED_YEARS) - 400000;
    remaining %= FOUR_HUNDRED_YEARS;
    remaining -= 1;
    let yd1 = remaining / HUNDRED_YEARS;
    remaining %= HUNDRED_YEARS;
    year += 100 * yd1;
    remaining += 1;
    let yd2 = remaining / FOUR_YEARS;
    remaining %= FOUR_YEARS;
    year += 4 * yd2;
    remaining -= 1;
    let yd3 = remaining / 365;
    remaining %= 365;
    year += yd3;
    let leap = (yd1 == 0 || yd2 != 0) && yd3 == 0;
    remaining += i64::from(leap);
    let mut month = 0;
    let lengths = [
        31,
        if leap { 29 } else { 28 },
        31,
        30,
        31,
        30,
        31,
        31,
        30,
        31,
        30,
        31,
    ];
    while remaining >= lengths[month] {
        remaining -= lengths[month];
        month += 1;
    }
    let day = remaining + 1;
    let hour = time / 3_600_000;
    let minute = (time / 60_000) % 60;
    let second = (time / 1000) % 60;
    let ms = time % 1000;
    let year = if (0..=9999).contains(&year) {
        format!("{year:04}")
    } else if year < 0 {
        format!("-{:06}", -year)
    } else {
        format!("+{year:06}")
    };
    Some(
        format!(
            "{year}-{:02}-{day:02}T{hour:02}:{minute:02}:{second:02}.{ms:03}Z",
            month + 1
        )
        .into(),
    )
}
