use std::collections::HashMap;
use std::io::{BufReader, Read, Write};
use std::path::Path;
use std::process::{Child, ChildStdin, ChildStdout, Command, Stdio};

use serde::Serialize;
use serde_json::{Value, json};

use super::{TsgoBinary, TsgoError};

pub(super) struct Channel {
    child: Child,
    input: ChildStdin,
    output: BufReader<ChildStdout>,
    pub virtual_files: HashMap<String, String>,
}

impl Channel {
    pub fn open(binary: &TsgoBinary, root: &Path) -> Result<Self, TsgoError> {
        binary.validate()?;
        let mut child = Command::new(&binary.path)
            .args(["--api", "--cwd"])
            .arg(root)
            .arg("--callbacks=readFile")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit())
            .spawn()?;
        let input = child
            .stdin
            .take()
            .ok_or_else(|| TsgoError::protocol("native compiler stdin unavailable"))?;
        let output = child
            .stdout
            .take()
            .ok_or_else(|| TsgoError::protocol("native compiler stdout unavailable"))?;
        Ok(Self {
            child,
            input,
            output: BufReader::new(output),
            virtual_files: HashMap::new(),
        })
    }

    pub fn json(&mut self, method: &str, parameters: impl Serialize) -> Result<Value, TsgoError> {
        let bytes = self.binary(method, parameters)?;
        if bytes.is_empty() {
            Ok(Value::Null)
        } else {
            Ok(serde_json::from_slice(&bytes)?)
        }
    }

    pub fn binary(
        &mut self,
        method: &str,
        parameters: impl Serialize,
    ) -> Result<Vec<u8>, TsgoError> {
        self.write_tuple(1, method.as_bytes(), &serde_json::to_vec(&parameters)?)?;
        loop {
            if self.byte()? != 0x93 {
                return Err(TsgoError::protocol("expected a MessagePack 3-tuple"));
            }
            let marker = self.byte()?;
            let kind = match marker {
                0..=0x7f => marker,
                0xcc => self.byte()?,
                _ => return Err(TsgoError::protocol("invalid MessagePack message type")),
            };
            let name = self.bin()?;
            let payload = self.bin()?;
            if kind == 6 {
                self.callback(&name, &payload)?;
                continue;
            }
            if name != method.as_bytes() {
                return Err(TsgoError::protocol(format!(
                    "response method mismatch: expected {method}, got {}",
                    String::from_utf8_lossy(&name)
                )));
            }
            return match kind {
                4 => Ok(payload),
                5 => Err(TsgoError::Compiler {
                    method: method.to_owned(),
                    message: String::from_utf8_lossy(&payload).into_owned(),
                }),
                _ => Err(TsgoError::protocol(format!(
                    "unexpected native message type {kind}"
                ))),
            };
        }
    }

    fn callback(&mut self, name: &[u8], payload: &[u8]) -> Result<(), TsgoError> {
        let result = (|| {
            if name != b"readFile" {
                return Err(TsgoError::protocol(format!(
                    "unknown compiler callback {}",
                    String::from_utf8_lossy(name)
                )));
            }
            let file: String = serde_json::from_slice(payload)?;
            match self.virtual_files.get(&file) {
                Some(content) => Ok(serde_json::to_vec(&json!({ "content": content }))?),
                None => Ok(Vec::new()),
            }
        })();
        match result {
            Ok(payload) => self.write_tuple(2, name, &payload),
            Err(error) => {
                self.write_tuple(3, name, error.to_string().as_bytes())?;
                Err(error)
            }
        }
    }

    fn write_tuple(&mut self, kind: u8, name: &[u8], payload: &[u8]) -> Result<(), TsgoError> {
        self.input.write_all(&[0x93, kind])?;
        for part in [name, payload] {
            let length = u32::try_from(part.len())
                .map_err(|_| TsgoError::protocol("compiler message exceeds MessagePack bin32"))?;
            self.input.write_all(&[0xc6])?;
            self.input.write_all(&length.to_be_bytes())?;
            self.input.write_all(part)?;
        }
        self.input.flush()?;
        Ok(())
    }

    fn byte(&mut self) -> Result<u8, TsgoError> {
        let mut byte = [0];
        self.output.read_exact(&mut byte)?;
        Ok(byte[0])
    }

    fn bin(&mut self) -> Result<Vec<u8>, TsgoError> {
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
                usize::try_from(u32::from_be_bytes(bytes)).map_err(|_| {
                    TsgoError::protocol("compiler message length exceeds this platform")
                })?
            }
            marker => {
                return Err(TsgoError::protocol(format!(
                    "expected MessagePack binary, received {marker:#x}"
                )));
            }
        };
        let mut bytes = Vec::new();
        bytes.try_reserve_exact(length).map_err(|error| {
            TsgoError::protocol(format!("cannot allocate native compiler response: {error}"))
        })?;
        bytes.resize(length, 0);
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
