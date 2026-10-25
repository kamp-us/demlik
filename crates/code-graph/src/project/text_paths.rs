use crate::text::JsString;
use std::{io, path::Path};

const SLASH: u16 = b'/' as u16;
const DOT: u16 = b'.' as u16;
const PARENT: &[u16] = &[DOT, DOT];

// JSON configuration paths must retain code units until the actual native filesystem call.
pub(crate) fn normalize_path_text(path: &JsString) -> JsString {
    let absolute = path.starts_with("/");
    let mut stack: Vec<&[u16]> = Vec::new();
    for part in path.units().split(|unit| *unit == SLASH) {
        if part.is_empty() || part == [DOT] {
            continue;
        }
        if part == PARENT {
            if stack.last().is_some_and(|last| *last != PARENT) {
                stack.pop();
            } else if !absolute {
                stack.push(part);
            }
        } else {
            stack.push(part);
        }
    }
    let mut units = if absolute { vec![SLASH] } else { Vec::new() };
    for part in stack {
        if !units.is_empty() && units.last() != Some(&SLASH) {
            units.push(SLASH);
        }
        units.extend_from_slice(part);
    }
    if units.is_empty() {
        units.push(DOT);
    }
    if path.units().last() == Some(&SLASH) && units.last() != Some(&SLASH) {
        units.push(SLASH);
    }
    JsString::from_units(units)
}
pub(crate) fn join_path_text(base: &JsString, child: &JsString) -> JsString {
    if base.is_empty() {
        return normalize_path_text(child);
    }
    if child.is_empty() {
        return normalize_path_text(base);
    }
    let mut joined = base.clone();
    joined.push_str("/");
    joined.extend(child);
    normalize_path_text(&joined)
}
fn absolute(path: &JsString) -> Result<JsString, io::Error> {
    if path.starts_with("/") {
        return Ok(normalize_path_text(path));
    }
    let cwd = std::env::current_dir()?;
    Ok(join_path_text(&cwd.to_string_lossy().as_ref().into(), path))
}
pub(crate) fn resolve_path_text(base: &Path, child: &JsString) -> Result<JsString, io::Error> {
    if child.starts_with("/") {
        return Ok(normalize_path_text(child));
    }
    absolute(&join_path_text(
        &base.to_string_lossy().as_ref().into(),
        child,
    ))
}
pub(crate) fn relative_path_text(root: &Path, target: &JsString) -> Result<JsString, io::Error> {
    let root = absolute(&root.to_string_lossy().as_ref().into())?;
    let target = absolute(target)?;
    let from: Vec<_> = root
        .units()
        .split(|unit| *unit == SLASH)
        .filter(|part| !part.is_empty())
        .collect();
    let to: Vec<_> = target
        .units()
        .split(|unit| *unit == SLASH)
        .filter(|part| !part.is_empty())
        .collect();
    let common = from
        .iter()
        .zip(&to)
        .take_while(|(left, right)| left == right)
        .count();
    let mut parts: Vec<&[u16]> = (common..from.len()).map(|_| PARENT).collect();
    parts.extend_from_slice(&to[common..]);
    let mut units = Vec::new();
    for (index, part) in parts.into_iter().enumerate() {
        if index > 0 {
            units.push(SLASH);
        }
        units.extend_from_slice(part);
    }
    Ok(JsString::from_units(units))
}
