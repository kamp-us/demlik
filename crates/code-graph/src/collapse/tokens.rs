use crate::project::locale_compare;
use indexmap::IndexSet;
const STOPWORDS: &[&str] = &[
    "a",
    "all",
    "an",
    "and",
    "args",
    "arg",
    "as",
    "at",
    "build",
    "by",
    "cb",
    "compute",
    "create",
    "data",
    "do",
    "each",
    "ensure",
    "execute",
    "fn",
    "for",
    "from",
    "get",
    "handle",
    "has",
    "id",
    "in",
    "info",
    "init",
    "is",
    "item",
    "key",
    "kind",
    "list",
    "load",
    "make",
    "map",
    "name",
    "new",
    "of",
    "on",
    "one",
    "opt",
    "opts",
    "option",
    "options",
    "or",
    "params",
    "parse",
    "prop",
    "props",
    "read",
    "render",
    "resolve",
    "result",
    "run",
    "subscribe",
    "set",
    "the",
    "to",
    "type",
    "use",
    "value",
    "with",
    "write",
];
const SUFFIXES: &[&str] = &[
    "ations", "ation", "izes", "ized", "izing", "ize", "ings", "ing", "ers", "er", "es", "s",
];
fn stem(token: &str) -> &str {
    for suffix in SUFFIXES {
        if token.len() > suffix.len() + 2 && token.ends_with(suffix) {
            return &token[..token.len() - suffix.len()];
        }
    }
    token
}
pub(super) fn name_tokens(name: &str) -> IndexSet<String> {
    let chars: Vec<_> = name.chars().collect();
    let mut split = String::new();
    for (i, ch) in chars.iter().copied().enumerate() {
        if i > 0
            && ch.is_ascii_uppercase()
            && (chars[i - 1].is_ascii_lowercase()
                || chars[i - 1].is_ascii_digit()
                || (chars[i - 1].is_ascii_uppercase()
                    && chars.get(i + 1).is_some_and(char::is_ascii_lowercase)))
        {
            split.push(' ')
        }
        split.push(ch)
    }
    let mut tokens = IndexSet::new();
    for part in split
        .split(|ch: char| !ch.is_ascii_alphanumeric())
        .filter(|part| !part.is_empty())
    {
        let lower = part.to_ascii_lowercase();
        if STOPWORDS.contains(&lower.as_str()) {
            continue;
        }
        let word = stem(&lower);
        if word.len() >= 2 && !STOPWORDS.contains(&word) {
            tokens.insert(word.to_owned());
        }
    }
    let mut tokens: Vec<_> = tokens.into_iter().collect();
    tokens.sort_by(|a, b| locale_compare(a, b));
    tokens.into_iter().collect()
}
