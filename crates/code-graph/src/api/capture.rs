use std::{
    error::Error,
    io::{self, Read},
    process::{Command, ExitStatus, Stdio},
    sync::mpsc,
    thread,
};

pub(crate) const MAX_BUFFER: usize = 1024 * 1024;
const CHUNK: usize = 8192;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CaptureStream {
    Stdout,
    Stderr,
}
impl CaptureStream {
    fn index(self) -> usize {
        match self {
            Self::Stdout => 0,
            Self::Stderr => 1,
        }
    }
}

#[derive(Debug)]
pub enum CaptureFailure {
    Spawn(io::Error),
    ReaderSpawn {
        stream: CaptureStream,
        source: io::Error,
    },
    Read {
        stream: CaptureStream,
        source: io::Error,
    },
    Wait(io::Error),
    Kill(io::Error),
    OutputLimit {
        limit: usize,
        captured: usize,
    },
    ReaderPanic {
        stream: CaptureStream,
    },
}
impl std::fmt::Display for CaptureFailure {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Spawn(error) | Self::Wait(error) | Self::Kill(error) => error.fmt(f),
            Self::Read { stream, source } => write!(f, "{stream:?} read failed: {source}"),
            Self::ReaderSpawn { stream, source } => {
                write!(f, "{stream:?} reader could not start: {source}")
            }
            Self::OutputLimit { limit, captured } => write!(
                f,
                "process output exceeded {limit} bytes ({captured} captured)"
            ),
            Self::ReaderPanic { stream } => write!(f, "{stream:?} output reader panicked"),
        }
    }
}
impl Error for CaptureFailure {
    fn source(&self) -> Option<&(dyn Error + 'static)> {
        match self {
            Self::Spawn(error)
            | Self::Wait(error)
            | Self::Kill(error)
            | Self::Read { source: error, .. }
            | Self::ReaderSpawn { source: error, .. } => Some(error),
            Self::OutputLimit { .. } | Self::ReaderPanic { .. } => None,
        }
    }
}

pub(crate) struct Captured {
    pub stdout: Vec<u8>,
    pub stderr: Vec<u8>,
    pub status: Option<ExitStatus>,
    /// First failure determines the caller's source-facing classification.
    /// Subsequent reader, kill and wait failures remain available as evidence.
    pub failures: Vec<CaptureFailure>,
}
fn reader(
    mut pipe: impl Read,
    stream: CaptureStream,
    sender: mpsc::SyncSender<(CaptureStream, io::Result<Vec<u8>>)>,
) {
    loop {
        let mut buffer = vec![0; CHUNK];
        match pipe.read(&mut buffer) {
            Ok(0) => break,
            Ok(count) => {
                buffer.truncate(count);
                if sender.send((stream, Ok(buffer))).is_err() {
                    break;
                }
            }
            Err(error) if error.kind() == io::ErrorKind::Interrupted => continue,
            Err(error) => {
                let _ = sender.send((stream, Err(error)));
                break;
            }
        }
    }
}
fn terminate(child: &mut std::process::Child, failures: &mut Vec<CaptureFailure>) {
    // Node spawnSync defaults to SIGTERM. Child::kill uses SIGKILL on Unix,
    // which skips a tool's signal cleanup handler.
    #[cfg(unix)]
    let result = rustix::process::kill_process(
        rustix::process::Pid::from_child(child),
        rustix::process::Signal::TERM,
    )
    .map_err(io::Error::from);
    #[cfg(not(unix))]
    let result = child.kill();
    if let Err(error) = result {
        failures.push(CaptureFailure::Kill(error));
    }
}

/// The two native tooling callers share Node spawnSync's combined 1 MiB budget.
/// Stdin, argv validation and domain errors remain caller-owned. The first
/// overflowing chunk is retained; read-chunk overshoot and exit races are native.
pub(crate) fn capture(command: &mut Command) -> Captured {
    let mut result = Captured {
        stdout: vec![],
        stderr: vec![],
        status: None,
        failures: vec![],
    };
    let mut child = match command
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
    {
        Ok(child) => child,
        Err(error) => {
            result.failures.push(CaptureFailure::Spawn(error));
            return result;
        }
    };
    let (sender, receiver) = mpsc::sync_channel(4);
    let stdout = child.stdout.take().expect("requested stdout pipe");
    let stderr = child.stderr.take().expect("requested stderr pipe");
    let output_sender = sender.clone();
    let readers = [
        (
            CaptureStream::Stdout,
            thread::Builder::new()
                .spawn(move || reader(stdout, CaptureStream::Stdout, output_sender)),
        ),
        (
            CaptureStream::Stderr,
            thread::Builder::new().spawn(move || reader(stderr, CaptureStream::Stderr, sender)),
        ),
    ];
    let mut live_readers = Vec::with_capacity(2);
    for (stream, reader) in readers {
        match reader {
            Ok(reader) => live_readers.push((stream, reader)),
            Err(source) => {
                result
                    .failures
                    .push(CaptureFailure::ReaderSpawn { stream, source });
                terminate(&mut child, &mut result.failures);
            }
        }
    }
    let mut streams = [Vec::new(), Vec::new()];
    for (stream, chunk) in receiver {
        match chunk {
            Ok(bytes) if result.failures.is_empty() => {
                streams[stream.index()].extend(bytes);
                let captured = streams[0].len() + streams[1].len();
                if captured > MAX_BUFFER {
                    result.failures.push(CaptureFailure::OutputLimit {
                        limit: MAX_BUFFER,
                        captured,
                    });
                    terminate(&mut child, &mut result.failures);
                }
            }
            Ok(_) => {}
            Err(source) => {
                let first = result.failures.is_empty();
                result
                    .failures
                    .push(CaptureFailure::Read { stream, source });
                if first {
                    terminate(&mut child, &mut result.failures);
                }
            }
        }
    }
    for (stream, reader) in live_readers {
        if reader.join().is_err() {
            result.failures.push(CaptureFailure::ReaderPanic { stream });
        }
    }
    match child.wait() {
        Ok(status) => result.status = Some(status),
        Err(error) => result.failures.push(CaptureFailure::Wait(error)),
    }
    [result.stdout, result.stderr] = streams;
    result
}
