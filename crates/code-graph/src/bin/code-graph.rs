use std::{
    io::{self, IsTerminal},
    path::Path,
    process::ExitCode,
};

use demlik_code_graph::{
    cli::{
        frontdoor::{Preparation, RunCompletion, prepare_cli},
        io::{CliIo, exit_with},
        terminal::TerminalFacts,
    },
    engine::tsgo::TsgoBinary,
    render::tree::TreeStyle,
    text::JsString,
};

fn failure(host: &mut CliIo<'_>, message: &str) {
    host.write_stderr(&JsString::from(message));
    if let Err(error) = exit_with(host, 1.0) {
        host.write_stderr(&error.message());
    }
}

fn run(host: &mut CliIo<'_>, style: TreeStyle) -> i32 {
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
    let compiler = match std::env::var_os("DEMLIK_CODE_GRAPH_COMPILER_MANIFEST") {
        Some(manifest) => TsgoBinary::from_native_preview_manifest(Path::new(&manifest)),
        None => match std::env::current_exe().and_then(std::fs::canonicalize) {
            Ok(executable) => {
                TsgoBinary::from_installation(executable.parent().unwrap_or(&executable))
            }
            Err(error) => Err(error.into()),
        },
    };
    let compiler = match compiler {
        Ok(compiler) => compiler,
        Err(error) => {
            failure(host, &format!("{error}\n"));
            return host.normal_exit_code();
        }
    };
    match prepared.run_with_style_blocking(host, &compiler, style) {
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
    let style = TerminalFacts::snapshot(stdout.is_terminal()).tree_style();
    let mut out = stdout.lock();
    let mut err = stderr.lock();
    let mut host = CliIo::new(&mut out, &mut err, None);
    let code = run(&mut host, style);
    ExitCode::from(u8::try_from(code).unwrap_or(1))
}
