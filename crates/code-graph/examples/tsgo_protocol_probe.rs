//! Bounded proof of a Rust client talking directly to the pinned native Go compiler.

use std::fs;
use std::io::{self, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, ChildStdout, Command, Stdio};
use std::time::{SystemTime, UNIX_EPOCH};

use serde_json::{Value, json};

const PIN: &str = "7.0.0-dev.20260707.2";

struct Project(PathBuf);

impl Drop for Project {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

struct Channel {
    child: Child,
    input: ChildStdin,
    output: ChildStdout,
    observed: Vec<String>,
}

impl Channel {
    fn open(binary: &Path, root: &Path) -> io::Result<Self> {
        let mut child = Command::new(binary)
            .args(["--api", "--cwd"])
            .arg(root)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit())
            .spawn()?;
        let input = child
            .stdin
            .take()
            .ok_or_else(|| io::Error::other("missing child stdin"))?;
        let output = child
            .stdout
            .take()
            .ok_or_else(|| io::Error::other("missing child stdout"))?;
        Ok(Self {
            child,
            input,
            output,
            observed: Vec::new(),
        })
    }

    fn binary(&mut self, method: &str, parameters: Value) -> io::Result<Vec<u8>> {
        let payload = serde_json::to_vec(&parameters)?;
        self.input.write_all(&[0x93, 1])?;
        for part in [method.as_bytes(), &payload] {
            let length = u32::try_from(part.len()).map_err(io::Error::other)?;
            self.input.write_all(&[0xc6])?;
            self.input.write_all(&length.to_be_bytes())?;
            self.input.write_all(part)?;
        }
        self.input.flush()?;
        self.observed.push(method.to_owned());
        let mut header = [0; 2];
        self.output.read_exact(&mut header)?;
        if header[0] != 0x93 {
            return Err(io::Error::other("expected a MessagePack 3-tuple"));
        }
        let kind = if header[1] == 0xcc {
            self.byte()?
        } else {
            header[1]
        };
        let name = self.bin()?;
        let payload = self.bin()?;
        if name != method.as_bytes() {
            return Err(io::Error::other("response method mismatch"));
        }
        match kind {
            4 => Ok(payload),
            5 => Err(io::Error::other(
                String::from_utf8_lossy(&payload).into_owned(),
            )),
            kind => Err(io::Error::other(format!(
                "unexpected message kind {kind}; this probe registers no callbacks"
            ))),
        }
    }

    fn json(&mut self, method: &str, parameters: Value) -> io::Result<Value> {
        let response = self.binary(method, parameters)?;
        if response.is_empty() {
            Ok(Value::Null)
        } else {
            serde_json::from_slice(&response).map_err(io::Error::other)
        }
    }

    fn byte(&mut self) -> io::Result<u8> {
        let mut byte = [0];
        self.output.read_exact(&mut byte)?;
        Ok(byte[0])
    }

    fn bin(&mut self) -> io::Result<Vec<u8>> {
        let length = match self.byte()? {
            0xc4 => usize::from(self.byte()?),
            0xc5 => {
                let mut bytes = [0; 2];
                self.output.read_exact(&mut bytes)?;
                usize::from(u16::from_be_bytes(bytes))
            }
            0xc6 => {
                let mut bytes = [0; 4];
                self.output.read_exact(&mut bytes)?;
                usize::try_from(u32::from_be_bytes(bytes)).map_err(io::Error::other)?
            }
            marker => {
                return Err(io::Error::other(format!(
                    "expected MessagePack binary, received {marker:#x}"
                )));
            }
        };
        let mut bytes = vec![0; length];
        self.output.read_exact(&mut bytes)?;
        Ok(bytes)
    }
}

impl Drop for Channel {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

fn word(bytes: &[u8], at: usize) -> io::Result<u32> {
    let word: [u8; 4] = bytes
        .get(at..at + 4)
        .ok_or_else(|| io::Error::other("truncated AST header"))?
        .try_into()
        .map_err(io::Error::other)?;
    Ok(u32::from_le_bytes(word))
}

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let binary = std::env::args_os()
        .nth(1)
        .ok_or("usage: tsgo_protocol_probe <pinned-native-tsgo>")?;
    let version = Command::new(&binary).arg("--version").output()?;
    assert!(version.status.success());
    assert_eq!(
        String::from_utf8(version.stdout)?.trim(),
        format!("Version {PIN}")
    );
    let unique = SystemTime::now().duration_since(UNIX_EPOCH)?.as_nanos();
    let root = std::env::temp_dir().join(format!(
        "demlik-native-tsgo-{}-{unique}",
        std::process::id()
    ));
    fs::create_dir(&root)?;
    let project = Project(fs::canonicalize(root)?);
    let config = project.0.join("tsconfig.json");
    let source = project.0.join("main.ts");
    fs::write(
        &config,
        r#"{ "compilerOptions": { "module": "esnext", "moduleResolution": "bundler", "target": "es2022", "types": [] }, "files": ["main.ts"] }"#,
    )?;
    fs::write(&source, "export { value as renamed } from './origin.js';\n")?;
    fs::write(project.0.join("origin.ts"), "export const value = 17;\n")?;
    let mut channel = Channel::open(Path::new(&binary), &project.0)?;
    let initialization = channel.json("initialize", Value::Null)?;
    let parsed = channel.json("parseConfigFile", json!({ "file": config }))?;
    assert!(
        parsed["fileNames"]
            .as_array()
            .ok_or("config returned no root files")?
            .contains(&json!(source))
    );
    let opened = channel.json("updateSnapshot", json!({ "openProjects": [config] }))?;
    let snapshot = opened["snapshot"].as_u64().ok_or("snapshot missing")?;
    let project_id = opened["projects"][0]["id"]
        .as_str()
        .ok_or("project missing")?
        .to_owned();
    let ast = channel.binary(
        "getSourceFile",
        json!({ "snapshot": snapshot, "project": project_id, "file": source }),
    )?;
    let protocol = word(&ast, 0)? >> 24;
    assert_eq!(protocol, 5);
    let nodes = usize::try_from(word(&ast, 40)?)?;
    let source_kind = word(&ast, nodes + 28)?;
    let extended = usize::try_from(word(&ast, 32)?)?
        + usize::try_from(word(&ast, nodes + 28 + 20)? & 0x00ff_ffff)?;
    let path_index = usize::try_from(word(&ast, extended + 8)?)?;
    let offsets = usize::try_from(word(&ast, 24)?)? + path_index * 4;
    let strings = usize::try_from(word(&ast, 28)?)?;
    let start = strings + usize::try_from(word(&ast, offsets)?)?;
    let end = strings + usize::try_from(word(&ast, offsets + 4)?)?;
    let canonical_path =
        std::str::from_utf8(ast.get(start..end).ok_or("invalid AST path offsets")?)?;
    let handle = format!("1.{source_kind}.{canonical_path}");
    let module = channel.json(
        "getSymbolAtLocation",
        json!({ "snapshot": snapshot, "project": project_id, "location": handle }),
    )?;
    let exports = channel.json(
        "getExportsOfModule",
        json!({ "snapshot": snapshot, "project": project_id, "symbol": module["id"] }),
    )?;
    let renamed = exports
        .as_array()
        .ok_or("exports missing")?
        .iter()
        .find(|symbol| symbol["name"] == "renamed")
        .ok_or("re-exported alias missing")?;
    let target = channel.json(
        "getAliasedSymbol",
        json!({ "snapshot": snapshot, "project": project_id, "symbol": renamed["id"] }),
    )?;
    assert_eq!(target["name"], "value");
    assert!(
        target["declarations"]
            .as_array()
            .ok_or("declarations missing")?
            .iter()
            .any(|handle| handle
                .as_str()
                .is_some_and(|handle| handle.ends_with("/origin.ts")))
    );
    channel.json("release", json!({ "snapshot": snapshot }))?;
    let closed = channel.json("updateSnapshot", json!({ "closeProjects": [config] }))?;
    channel.json("release", json!({ "snapshot": closed["snapshot"] }))?;
    println!(
        "{}",
        serde_json::to_string_pretty(
            &json!({ "binaryVersion": PIN, "astProtocol": protocol, "initialization": initialization, "exportName": renamed["name"], "declarationName": target["name"], "declarations": target["declarations"], "observedNativeCompilerMethods": channel.observed })
        )?
    );
    Ok(())
}
