use super::rules::JsRegex;
use crate::text::JsString;
const STAR: u16 = b'*' as u16;
const SLASH: u16 = b'/' as u16;
const QUESTION: u16 = b'?' as u16;
const OPEN: u16 = b'{' as u16;
const CLOSE: u16 = b'}' as u16;
const COMMA: u16 = b',' as u16;

#[derive(Debug)]
pub enum GlobError {
    Syntax(JsString),
    Pattern(regress::Error),
}
impl std::fmt::Display for GlobError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Syntax(message) => formatter.write_str(&message.to_lossy()),
            Self::Pattern(error) => error.fmt(formatter),
        }
    }
}
impl std::error::Error for GlobError {}
fn unclosed(glob: &JsString) -> GlobError {
    let mut message = JsString::from("unclosed \"{\" in glob \"");
    message.extend(glob);
    message.push_str("\"");
    GlobError::Syntax(message)
}
fn compile_range(
    glob: &JsString,
    start: usize,
    stops: &[u16],
) -> Result<(JsString, usize), GlobError> {
    let units = glob.units();
    let mut source = JsString::default();
    let mut index = start;
    while let Some(&unit) = units.get(index) {
        if stops.contains(&unit) {
            break;
        }
        if units[index..].starts_with(&[STAR, STAR, SLASH]) {
            source.push_str("(?:[^/]*/)*");
            index += 3;
        } else if units[index..].starts_with(&[STAR, STAR]) {
            source.push_str(".*");
            index += 2;
        } else if unit == STAR {
            source.push_str("[^/]*");
            index += 1;
        } else if unit == QUESTION {
            source.push_str("[^/]");
            index += 1;
        } else if unit == OPEN {
            let mut next = index + 1;
            let mut alternatives = Vec::new();
            loop {
                let (part, end) = compile_range(glob, next, &[COMMA, CLOSE])?;
                alternatives.push(part);
                if end >= units.len() {
                    return Err(unclosed(glob));
                }
                next = end + 1;
                if units[end] == CLOSE {
                    break;
                }
            }
            source.push_str("(?:");
            for (index, alternative) in alternatives.iter().enumerate() {
                if index > 0 {
                    source.push_str("|");
                }
                source.extend(alternative);
            }
            source.push_str(")");
            index = next;
        } else if unit == CLOSE || unit == COMMA {
            let mut message = JsString::from("unbalanced \"");
            message.extend(&JsString::from_units(vec![unit]));
            message.push_str(&format!("\" at {index} in glob \""));
            message.extend(glob);
            message.push_str("\"");
            return Err(GlobError::Syntax(message));
        } else {
            if ".+^$()|[]\\".encode_utf16().any(|literal| literal == unit) {
                source.push_str("\\");
            }
            source.extend(&JsString::from_units(vec![unit]));
            index += 1;
        }
    }
    Ok((source, index))
}
pub fn glob_to_regexp(glob: &JsString) -> Result<JsRegex, GlobError> {
    let (source, _) = compile_range(glob, 0, &[])?;
    let mut anchored = JsString::from("^");
    anchored.extend(&source);
    anchored.push_str("$");
    JsRegex::new(&anchored).map_err(GlobError::Pattern)
}
