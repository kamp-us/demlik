use crate::{
    api::{
        base::{checkout_of, names_at_base, resolve_base},
        map::{ApiError, ApiInputError},
        model::{Bump, Changeset, ChangesetBump, ChangesetsSince},
        package_root,
    },
    project::{find_repo_root, join_path_text},
    render::text::join,
    text::{JsRegex, JsString, JsValue},
};
use indexmap::IndexMap;
use std::{collections::HashSet, fs, path::Path, sync::LazyLock};

#[derive(Default)]
pub struct ChangesetsOptions<'a> {
    pub repo_root: Option<&'a JsString>,
}

fn cannot_read_name(file: &JsString) -> ApiInputError {
    let mut message = JsString::from("cannot read ");
    message.extend(file);
    message.push_str("; the ratchet needs the package's name");
    ApiInputError::new(message)
}
fn package_name(root: &JsString) -> Result<JsString, ApiError> {
    let file = join_path_text(root, &"package.json".into());
    let bytes = fs::read(file.to_lossy())
        .map_err(|cause| ApiError::Input(cannot_read_name(&file).with_cause(cause)))?;
    let value = JsValue::parse(&String::from_utf8_lossy(&bytes))
        .map_err(|cause| ApiError::Input(cannot_read_name(&file).with_cause(cause)))?;
    if matches!(value, JsValue::Null) {
        return Err(ApiError::Input(cannot_read_name(&file)));
    }
    if let Some(JsValue::String(name)) = value.get("name")
        && !name.is_empty()
    {
        return Ok(name.clone());
    }
    let mut message = file;
    message.push_str(" has no name; the ratchet needs the package's name");
    Err(ApiError::Input(ApiInputError::new(message)))
}
fn io_error(path: &JsString, source: std::io::Error) -> ApiError {
    ApiError::Io {
        path: path.clone(),
        source,
    }
}
fn files_now(root: &JsString) -> Result<Vec<JsString>, ApiError> {
    let dir = join_path_text(root, &".changeset".into());
    let path = dir.to_lossy();
    if !Path::new(&path).exists()
        || !fs::metadata(&path)
            .map_err(|source| io_error(&dir, source))?
            .is_dir()
    {
        return Ok(vec![]);
    }
    let mut files = vec![];
    for entry in fs::read_dir(path).map_err(|source| io_error(&dir, source))? {
        let entry = entry.map_err(|source| io_error(&dir, source))?;
        if !entry
            .file_type()
            .map_err(|source| io_error(&dir, source))?
            .is_file()
        {
            continue;
        }
        let name = JsString::from(entry.file_name().to_string_lossy().as_ref());
        if name.units().ends_with(&[46, 109, 100]) && name != "README.md" {
            let mut file = JsString::from(".changeset/");
            file.extend(&name);
            files.push(file);
        }
    }
    files.sort();
    Ok(files)
}

/// Read counted, newly added changesets without changing the checkout. This call
/// blocks on filesystem and Git reads; no initialization or compiler run occurs.
pub fn read_changesets_since(
    root: &JsString,
    base: &JsString,
    options: ChangesetsOptions<'_>,
) -> Result<ChangesetsSince, ApiError> {
    let root = package_root(root)?;
    let named = package_name(&root)?;
    let discovered;
    let repo_root = match options.repo_root {
        Some(root) => root,
        None => {
            discovered = find_repo_root(Path::new(&root.to_lossy()))
                .to_string_lossy()
                .as_ref()
                .into();
            &discovered
        }
    };
    let sha = resolve_base(&checkout_of(&root)?, base)?;
    let at_base = names_at_base(repo_root, &sha, &".changeset/".into())?
        .into_iter()
        .collect::<HashSet<_>>();
    let mut changesets = vec![];
    for file in files_now(repo_root)?
        .into_iter()
        .filter(|file| !at_base.contains(file))
    {
        let absolute = join_path_text(repo_root, &file);
        let bytes = fs::read(absolute.to_lossy()).map_err(|source| io_error(&absolute, source))?;
        let text = JsString::from(String::from_utf8_lossy(&bytes).as_ref());
        let Some(parsed) = parse_changeset(&text) else {
            let mut message = JsString::from("changeset ");
            message.extend(&file);
            message.push_str(" has no frontmatter that parses: expected a block between two --- lines whose lines read \"<package>\": major | minor | patch | none");
            return Err(ApiError::Input(ApiInputError::new(message)));
        };
        let bump = match parsed.bumps.get(&named) {
            Some(Bump::Major) => ChangesetBump::Major,
            Some(Bump::Minor) => ChangesetBump::Minor,
            Some(Bump::Patch) => ChangesetBump::Patch,
            Some(Bump::None) | None => continue,
        };
        changesets.push(Changeset {
            file,
            bump,
            body: parsed.body,
        });
    }
    Ok(ChangesetsSince {
        package: named,
        changesets,
    })
}

pub struct ChangesetText {
    pub bumps: IndexMap<JsString, Bump>,
    pub body: JsString,
}
static BUMP_LINE: LazyLock<JsRegex> = LazyLock::new(|| {
    JsRegex::new(
        &r#"^\s*(?:"([^"]+)"|'([^']+)'|([^\s:"']+))\s*:\s*(major|minor|patch|none)\s*$"#.into(),
    )
    .expect("the source bump pattern is valid")
});
static DELIMITER: LazyLock<JsRegex> =
    LazyLock::new(|| JsRegex::new(&r"^---\s*$".into()).expect("delimiter pattern"));
static BLANK: LazyLock<JsRegex> =
    LazyLock::new(|| JsRegex::new(&r"^\s*$".into()).expect("blank pattern"));

pub fn parse_changeset(text: &JsString) -> Option<ChangesetText> {
    let units = text.units().strip_prefix(&[0xfeff]).unwrap_or(text.units());
    let parts = units.split(|unit| *unit == 10).collect::<Vec<_>>();
    let lines = parts
        .iter()
        .enumerate()
        .map(|(index, part)| {
            let part = if index + 1 < parts.len() {
                part.strip_suffix(&[13]).unwrap_or(part)
            } else {
                part
            };
            JsString::from_units(part.to_vec())
        })
        .collect::<Vec<_>>();
    if !DELIMITER.test(lines.first()?) {
        return None;
    }
    let closing = lines
        .iter()
        .enumerate()
        .skip(1)
        .find(|(_, line)| DELIMITER.test(line))?
        .0;
    let mut bumps = IndexMap::new();
    for line in &lines[1..closing] {
        if BLANK.test(line) {
            continue;
        }
        let groups = BUMP_LINE.capture_groups(line)?;
        let name = groups[..3]
            .iter()
            .flatten()
            .next()
            .expect("one package alternative matched")
            .clone();
        let bump = match groups[3]
            .as_ref()
            .expect("the bump group matched")
            .to_utf8()
            .as_deref()
        {
            Ok("major") => Bump::Major,
            Ok("minor") => Bump::Minor,
            Ok("patch") => Bump::Patch,
            Ok("none") => Bump::None,
            _ => unreachable!("only declared source bump alternatives match"),
        };
        bumps.insert(name, bump);
    }
    Some(ChangesetText {
        bumps,
        body: join(lines.into_iter().skip(closing + 1), "\n"),
    })
}
