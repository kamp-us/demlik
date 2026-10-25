//! The frozen CLI's output helpers and explicit process-exit/stdio facts.
use crate::{
    api::map::{ApiArgumentError, ApiError},
    render::text::number,
    text::JsString,
};
use std::{
    fs,
    io::{self, Write},
};

#[derive(Debug)]
pub struct ExitCodeError {
    pub requested: f64,
    integer: bool,
}
impl ExitCodeError {
    pub fn name(&self) -> &'static str {
        "RangeError"
    }
    pub fn code(&self) -> &'static str {
        "ERR_OUT_OF_RANGE"
    }
    pub fn message(&self) -> JsString {
        let mut received = number(self.requested);
        // Pinned Node22 internal/errors ERR_OUT_OF_RANGE/addNumericalSeparator
        // applies this grouping even to an integral scientific-notation string.
        if self.requested.is_finite()
            && self.requested.fract() == 0.0
            && self.requested.abs() > 4_294_967_296.0
        {
            let start = usize::from(received.starts_with('-'));
            let mut position = received.len();
            while position >= start + 4 {
                position -= 3;
                received.insert(position, '_');
            }
        }
        format!(
            "The value of \"code\" is out of range. It must be {}. Received {received}",
            if self.integer {
                ">= -9007199254740991 && <= 9007199254740991"
            } else {
                "an integer"
            }
        )
        .into()
    }
}
impl std::fmt::Display for ExitCodeError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(&self.message().to_lossy())
    }
}
impl std::error::Error for ExitCodeError {}

#[derive(Debug)]
pub struct ExitState {
    requested: Option<f64>,
    stored: Option<i32>,
}
impl ExitState {
    pub fn stored_code(&self) -> Option<i32> {
        self.stored
    }
    pub fn requested_code(&self) -> Option<f64> {
        self.requested
    }
    fn assign(&mut self, requested: f64) -> Result<(), ExitCodeError> {
        let integer = requested.is_finite() && requested.fract() == 0.0;
        if !integer || requested.abs() > 9_007_199_254_740_991.0 {
            return Err(ExitCodeError { requested, integer });
        }
        // Node22 bootstrap validates a safe integer then writes an Int32Array.
        self.requested = Some(requested);
        self.stored = Some((requested as i64) as i32);
        Ok(())
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StdioStream {
    Stdout,
    Stderr,
}
#[derive(Debug)]
pub struct StdioFailure {
    pub stream: StdioStream,
    pub attempted_bytes: usize,
    pub suppressed_writes: usize,
    pub source: io::Error,
}
pub struct CliIo<'a> {
    stdout: &'a mut dyn Write,
    stderr: &'a mut dyn Write,
    exit: ExitState,
    pending: Vec<StdioFailure>,
}
impl<'a> CliIo<'a> {
    pub fn new(
        stdout: &'a mut dyn Write,
        stderr: &'a mut dyn Write,
        initial_exit_code: Option<i32>,
    ) -> Self {
        Self {
            stdout,
            stderr,
            exit: ExitState {
                requested: initial_exit_code.map(f64::from),
                stored: initial_exit_code,
            },
            pending: Vec::new(),
        }
    }
    pub fn exit_state(&self) -> &ExitState {
        &self.exit
    }
    pub fn pending_stdio_failures(&self) -> &[StdioFailure] {
        &self.pending
    }
    /// An explicit notification boundary; a subsequent write may try the sink again.
    pub fn take_stdio_failures(&mut self) -> Vec<StdioFailure> {
        std::mem::take(&mut self.pending)
    }
    pub fn normal_exit_code(&self) -> i32 {
        if self.pending.is_empty() {
            self.exit.stored.unwrap_or(0)
        } else {
            1
        }
    }
    pub(crate) fn assign_exit(&mut self, code: f64) -> Result<(), ExitCodeError> {
        self.exit.assign(code)
    }
    pub fn write_stdout(&mut self, payload: &JsString) {
        self.write(StdioStream::Stdout, payload);
    }
    pub fn write_stderr(&mut self, payload: &JsString) {
        self.write(StdioStream::Stderr, payload);
    }
    fn write(&mut self, stream: StdioStream, payload: &JsString) {
        if let Some(pending) = self
            .pending
            .iter_mut()
            .find(|failure| failure.stream == stream)
        {
            pending.suppressed_writes += 1;
            return;
        }
        let encoded = payload.to_lossy();
        let writer = match stream {
            StdioStream::Stdout => &mut self.stdout,
            StdioStream::Stderr => &mut self.stderr,
        };
        // Node still attempts an empty write. std::Write::write_all skips it.
        let result = if encoded.is_empty() {
            writer.write(&[]).map(|_| ())
        } else {
            writer.write_all(encoded.as_bytes())
        };
        if let Err(source) = result {
            self.pending.push(StdioFailure {
                stream,
                attempted_bytes: encoded.len(),
                suppressed_writes: 0,
                source,
            });
        }
    }
}

pub fn clean_exit(host: &mut CliIo<'_>, message: &JsString) {
    let mut line = JsString::from("code-graph: ");
    line.extend(message);
    line.push_str("\n");
    host.write_stderr(&line);
    host.exit.assign(2.0).expect("literal exit code is valid");
}
pub fn exit_with(host: &mut CliIo<'_>, code: f64) -> Result<(), ExitCodeError> {
    if code != 0.0 {
        host.exit.assign(code)?;
    }
    Ok(())
}

pub struct OutputTo<'a> {
    destination: Option<&'a JsString>,
}
pub fn output_to(destination: Option<&JsString>) -> OutputTo<'_> {
    OutputTo { destination }
}
impl OutputTo<'_> {
    pub fn emit(&self, host: &mut CliIo<'_>, payload: &JsString) -> Result<(), ApiError> {
        let Some(destination) = self.destination else {
            host.write_stdout(payload);
            return Ok(());
        };
        let bytes = payload.to_lossy().into_bytes();
        fs::write(destination.to_lossy(), &bytes).map_err(|source| {
            match ApiArgumentError::from_null_path(destination, source) {
                Ok(error) => ApiError::Argument(error),
                Err(source) => ApiError::Io {
                    path: destination.clone(),
                    source,
                },
            }
        })?;
        let mut line = JsString::from(format!("code-graph: wrote {} bytes to ", bytes.len()));
        line.extend(destination);
        line.push_str("\n");
        host.write_stderr(&line);
        Ok(())
    }
}
