use std::{io, path::Path, process::ExitCode};

use demlik_code_graph::{
    cli::{
        frontdoor::{Preparation, RunCompletion, prepare_cli},
        io::{CliIo, exit_with},
    },
    engine::tsgo::TsgoBinary,
    text::JsString,
};

fn failure(host: &mut CliIo<'_>, message: &str) {
    host.write_stderr(&JsString::from(message));
    if let Err(error) = exit_with(host, 1.0) {
        host.write_stderr(&error.message());
    }
}

fn run(host: &mut CliIo<'_>) -> i32 {
    let arguments = match std::env::args_os()
        .skip(1)
        .map(|value| value.into_string().map(JsString::from))
        .collect::<Result<Vec<_>, _>>()
    {
        Ok(arguments) => arguments,
        Err(_) => {
            failure(host, "code-graph: argument is not valid UTF-8\n");
            return host.normal_exit_code();
        }
    };
    let prepared = match prepare_cli(&arguments, None, host) {
        Ok(Preparation::Prepared(value)) => value,
        Ok(Preparation::Stopped(stop)) => return stop.exit_code(host),
        Err(error) => {
            failure(
                host,
                &format!("{}: {}\n", error.name(), error.message().to_lossy()),
            );
            return host.normal_exit_code();
        }
    };
    // This first executable is workspace-local, using the package's installed pin.
    let manifest = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../packages/code-graph/node_modules/@typescript/native-preview/package.json");
    let compiler = match TsgoBinary::from_native_preview_manifest(&manifest) {
        Ok(compiler) => compiler,
        Err(error) => {
            failure(host, &format!("{error}\n"));
            return host.normal_exit_code();
        }
    };
    match prepared.run_blocking(host, &compiler) {
        Ok(RunCompletion::Continue(_carrier)) => {
            failure(
                host,
                "code-graph: CLI stage chain left an unhandled continuation\n",
            );
        }
        Ok(_) => {}
        Err(error) => failure(
            host,
            &format!("{}: {}\n", error.name(), error.message().to_lossy()),
        ),
    }
    host.normal_exit_code()
}

fn main() -> ExitCode {
    let stdout = io::stdout();
    let stderr = io::stderr();
    let mut out = stdout.lock();
    let mut err = stderr.lock();
    let mut host = CliIo::new(&mut out, &mut err, None);
    let code = run(&mut host);
    ExitCode::from(u8::try_from(code).unwrap_or(1))
}
