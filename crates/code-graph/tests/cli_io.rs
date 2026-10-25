use demlik_code_graph::cli::io::{CliIo, StdioStream, clean_exit, exit_with, output_to};
use std::{
    cell::Cell,
    io::{self, Write},
    rc::Rc,
};

struct BrokenWriter(Rc<Cell<usize>>);
impl Write for BrokenWriter {
    fn write(&mut self, _: &[u8]) -> io::Result<usize> {
        self.0.set(self.0.get() + 1);
        Err(io::Error::new(
            io::ErrorKind::BrokenPipe,
            "real sink refusal",
        ))
    }
    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

#[test]
fn exit_helper_keeps_original_zero_but_stores_wrapped_nonzero_requests() {
    let (mut stdout, mut stderr) = (Vec::new(), Vec::new());
    let mut host = CliIo::new(&mut stdout, &mut stderr, Some(7));
    exit_with(&mut host, 0.0).unwrap();
    assert_eq!(host.exit_state().stored_code(), Some(7));
    exit_with(&mut host, 4294967296.0).unwrap();
    assert_eq!(host.exit_state().stored_code(), Some(0));
    assert_eq!(host.exit_state().requested_code(), Some(4294967296.0));
    exit_with(&mut host, 9007199254740991.0).unwrap();
    assert_eq!(host.exit_state().stored_code(), Some(-1));
    let error = exit_with(&mut host, f64::NAN).unwrap_err();
    assert_eq!(error.code(), "ERR_OUT_OF_RANGE");
    assert_eq!(host.exit_state().stored_code(), Some(-1));
}

#[test]
fn empty_stdio_write_calls_the_sink_and_pending_failures_reset_only_on_drain() {
    let count = Rc::new(Cell::new(0));
    let mut stdout = BrokenWriter(count.clone());
    let mut stderr = Vec::new();
    let mut host = CliIo::new(&mut stdout, &mut stderr, None);
    output_to(None).emit(&mut host, &"".into()).unwrap();
    output_to(None).emit(&mut host, &"second".into()).unwrap();
    assert_eq!(count.get(), 1);
    assert_eq!(host.pending_stdio_failures().len(), 1);
    assert_eq!(host.pending_stdio_failures()[0].stream, StdioStream::Stdout);
    assert_eq!(host.pending_stdio_failures()[0].suppressed_writes, 1);
    assert_eq!(
        host.pending_stdio_failures()[0].source.kind(),
        io::ErrorKind::BrokenPipe
    );
    assert_eq!(host.take_stdio_failures().len(), 1);
    output_to(None)
        .emit(&mut host, &"after notification".into())
        .unwrap();
    assert_eq!(count.get(), 2);
}

#[test]
fn failed_stderr_keeps_clean_exit_request_as_data() {
    let mut stdout = Vec::new();
    let mut stderr = BrokenWriter(Rc::new(Cell::new(0)));
    let mut host = CliIo::new(&mut stdout, &mut stderr, Some(7));
    clean_exit(&mut host, &"refusal".into());
    assert_eq!(host.exit_state().stored_code(), Some(2));
    assert_eq!(host.exit_state().requested_code(), Some(2.0));
    assert_eq!(host.normal_exit_code(), 1);
    assert_eq!(host.pending_stdio_failures()[0].stream, StdioStream::Stderr);
}

#[test]
fn first_pending_streams_keep_actual_write_order_in_both_directions() {
    for stderr_first in [true, false] {
        let mut stdout = BrokenWriter(Rc::new(Cell::new(0)));
        let mut stderr = BrokenWriter(Rc::new(Cell::new(0)));
        let mut host = CliIo::new(&mut stdout, &mut stderr, None);
        if stderr_first {
            clean_exit(&mut host, &"warning".into());
            output_to(None).emit(&mut host, &"payload".into()).unwrap();
        } else {
            output_to(None).emit(&mut host, &"payload".into()).unwrap();
            clean_exit(&mut host, &"warning".into());
        }
        let order = host
            .pending_stdio_failures()
            .iter()
            .map(|failure| failure.stream)
            .collect::<Vec<_>>();
        assert_eq!(
            order,
            if stderr_first {
                vec![StdioStream::Stderr, StdioStream::Stdout]
            } else {
                vec![StdioStream::Stdout, StdioStream::Stderr]
            }
        );
    }
}
