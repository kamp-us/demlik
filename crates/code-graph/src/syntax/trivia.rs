use std::cell::RefCell;
use std::collections::HashMap;
use std::rc::Rc;

use serde::Serialize;

use super::file::Comment;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub struct CommentRange {
    pub pos: usize,
    pub end: usize,
}

#[derive(Debug)]
pub struct Trivia {
    units: Rc<[u16]>,
    comment_start_by_end: HashMap<usize, usize>,
    leading_cache: RefCell<HashMap<usize, Vec<CommentRange>>>,
    trailing_cache: RefCell<HashMap<usize, Vec<CommentRange>>>,
}

impl Trivia {
    pub fn new(units: Rc<[u16]>, comments: &[Comment]) -> Self {
        Self {
            units,
            comment_start_by_end: comments
                .iter()
                .map(|comment| (comment.end, comment.start))
                .collect(),
            leading_cache: RefCell::new(HashMap::new()),
            trailing_cache: RefCell::new(HashMap::new()),
        }
    }
    pub fn comment_start_ending_at(&self, position: usize) -> Option<usize> {
        self.comment_start_by_end.get(&position).copied()
    }
    pub fn previous_token_end(&self, start: usize) -> usize {
        let mut at = start;
        loop {
            while at > 0 && self.units.get(at - 1).is_some_and(|ch| whitespace(*ch)) {
                at -= 1;
            }
            match self.comment_start_by_end.get(&at) {
                Some(start) if *start < at => at = *start,
                _ => return at,
            }
        }
    }
    pub fn leading_at(&self, start: usize) -> Vec<CommentRange> {
        if let Some(cached) = self.leading_cache.borrow().get(&start) {
            return cached.clone();
        }
        let ranges = comment_ranges(&self.units, self.previous_token_end(start), false);
        self.leading_cache
            .borrow_mut()
            .insert(start, ranges.clone());
        ranges
    }
    pub fn trailing_at(&self, end: usize) -> Vec<CommentRange> {
        if let Some(cached) = self.trailing_cache.borrow().get(&end) {
            return cached.clone();
        }
        let ranges = comment_ranges(&self.units, end, true);
        self.trailing_cache.borrow_mut().insert(end, ranges.clone());
        ranges
    }
    pub fn next_token_start(&self, from: usize) -> usize {
        let mut at = from;
        loop {
            while self.units.get(at).is_some_and(|ch| whitespace(*ch)) {
                at += 1;
            }
            if !comment_starts(&self.units, at) {
                return at;
            }
            at = scan_comment(&self.units, at);
        }
    }
}

fn line_break(ch: u16) -> bool {
    matches!(ch, 10 | 13 | 0x2028 | 0x2029)
}
fn whitespace(ch: u16) -> bool {
    line_break(ch)
        || matches!(
            ch,
            32 | 9 | 11 | 12 | 0xa0 | 0x85 | 0x1680 | 0x202f | 0x205f | 0x3000 | 0xfeff | 0x2000
                ..=0x200b
        )
}
fn comment_starts(text: &[u16], at: usize) -> bool {
    text.get(at) == Some(&47)
        && text
            .get(at + 1)
            .is_some_and(|next| matches!(*next, 47 | 42))
}

fn scan_comment(text: &[u16], start: usize) -> usize {
    let mut at = start + 2;
    if text.get(start + 1) == Some(&47) {
        while at < text.len() && !line_break(text[at]) {
            at += 1;
        }
        return at;
    }
    while at < text.len() {
        if text[at] == 42 && text.get(at + 1) == Some(&47) {
            return at + 2;
        }
        at += 1;
    }
    at
}

fn comment_ranges(text: &[u16], start: usize, trailing: bool) -> Vec<CommentRange> {
    let mut at = start;
    if start == 0 && text.starts_with(&[35, 33]) {
        at = 2;
        while at < text.len() && !line_break(text[at]) {
            at += 1;
        }
    }
    let mut collecting = start == 0 || trailing;
    let mut out = Vec::new();
    while at < text.len() {
        let ch = text[at];
        let width = if ch == 13 {
            if text.get(at + 1) == Some(&10) { 2 } else { 1 }
        } else if ch == 10 {
            1
        } else {
            0
        };
        if width > 0 {
            at += width;
            if trailing {
                break;
            }
            collecting = true;
            continue;
        }
        if matches!(ch, 9 | 11 | 12 | 32) || ch > 127 && whitespace(ch) {
            at += 1;
            continue;
        }
        if !comment_starts(text, at) {
            break;
        }
        let end = scan_comment(text, at);
        if collecting {
            out.push(CommentRange { pos: at, end });
        }
        at = end;
    }
    out
}
