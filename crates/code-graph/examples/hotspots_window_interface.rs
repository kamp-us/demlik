use demlik_code_graph::{
    cli::{
        frontdoor::{GatePreflightDispatch, Preparation, ReportDispatch, prepare_cli},
        io::CliIo,
    },
    engine::tsgo::TsgoBinary,
    hotspots::{ChurnWindowError, LocalTimeZone, resolve_churn_window},
    render::tree::TreeStyle,
    text::JsString,
};
use std::{
    cell::{Cell, RefCell},
    error::Error,
    io::{self, Write},
    rc::Rc,
};

struct Borrowed<'a>(&'a Rc<RefCell<Vec<u8>>>);
impl Write for Borrowed<'_> {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        self.0.borrow_mut().extend_from_slice(bytes);
        Ok(bytes.len())
    }
    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}
fn main() -> Result<(), Box<dyn Error>> {
    let root = std::env::args().nth(1).expect("owned Git project path");
    let reads = Rc::new(Cell::new(0));
    let since = JsString::from("2026-03-08T02:30:00");
    let window = {
        let zone = LocalTimeZone::try_named(&JsString::from("America/Los_Angeles"))?;
        assert_eq!(zone.data_version(), "2025a", "actual prepared release data");
        resolve_churn_window(
            90.0,
            Some(&since),
            || {
                reads.set(reads.get() + 1);
                1_793_102_400_123.75
            },
            &zone,
        )?
    };
    assert_eq!(reads.get(), 1);
    assert_eq!(window.since_iso, "2026-03-08T10:30:00.000Z");
    assert_eq!(window.until_iso, "2026-10-27T12:00:00.123Z");
    assert_eq!(window.days, 233.0);
    assert_eq!(since, "2026-03-08T02:30:00");

    let zone = LocalTimeZone::try_named(&JsString::from("UTC"))?;
    let error =
        resolve_churn_window(90.0, Some(&JsString::from("not-a-date")), || 0.0, &zone).unwrap_err();
    assert_eq!(error.name(), "RangeError");
    let ChurnWindowError::InvalidTimeValue(original) = &error else {
        panic!("invalid date")
    };
    assert!(std::ptr::eq(
        error
            .source()
            .unwrap()
            .downcast_ref::<demlik_code_graph::hotspots::InvalidTimeValue>()
            .unwrap(),
        original
    ));
    assert!(original.value.is_nan());

    let bytes = Rc::new(RefCell::new(Vec::new()));
    let mut output = Borrowed(&bytes);
    let mut errors = Vec::new();
    let mut host = CliIo::new(&mut output, &mut errors, Some(7));
    let argv = [JsString::from(root), "--hotspots".into(), "--json".into()];
    let Preparation::Prepared(prepared) = prepare_cli(&argv, None, &mut host)? else {
        panic!("prepared")
    };
    let GatePreflightDispatch::Continue(prepared) = prepared.prepare_gates(&mut host)? else {
        panic!("gates")
    };
    let result = prepared.dispatch_reports_with_clock_blocking(
        &mut host,
        &TsgoBinary::pinned("/nonexistent/explicit-tsgo"),
        TreeStyle::Plain,
        || {
            reads.set(reads.get() + 1);
            1_793_102_400_123.75
        },
    )?;
    assert!(matches!(result, ReportDispatch::Complete));
    assert_eq!(host.normal_exit_code(), 7);
    assert_eq!(reads.get(), 2);
    drop(host);
    assert!(errors.is_empty());
    assert!(
        std::str::from_utf8(&bytes.borrow())?.contains("\"sinceIso\":\"2026-07-29T12:00:00.123Z\"")
    );
    println!(
        "borrowed Rc host/clock; owned result after zone drop; cheap Git report without tsconfig or Go"
    );
    Ok(())
}
