// Copyright (c) 2001, 2002, 2003, 2004, 2005, 2006, 2007, 2008, 2009, 2010,
// 2011, 2012, 2013, 2014, 2015, 2016, 2017, 2018 Python Software Foundation;
// All Rights Reserved. See V8-TIMSORT-LICENSE beside this file.
//
// Adapted from Node v22.21.1, commit 6ac4ab19ad02803f03b54501193397563e99988e:
// deps/v8/third_party/v8/builtins/array-sort.tq, lines 520-1303.
// Dense safe indices replace JS accessors/holes; the comparison/run/merge/gallop
// schedule is retained because NaN deltas make the source comparator nontransitive.
// Rows move once by permutation; there is no public generic sorting interface.
use super::ScopeCountViolation;
use std::cmp::Ordering;

pub(super) fn sort(rows: &mut [ScopeCountViolation]) {
    if rows.len() < 2 {
        return;
    }
    let order = {
        let mut state = State {
            rows,
            work: (0..rows.len()).collect(),
            temp: Vec::new(),
            runs: Vec::new(),
            min_gallop: 7,
        };
        state.sort();
        state.work
    };
    let mut destinations = vec![0; rows.len()];
    for (destination, source) in order.into_iter().enumerate() {
        destinations[source] = destination;
    }
    for index in 0..rows.len() {
        while destinations[index] != index {
            let destination = destinations[index];
            rows.swap(index, destination);
            destinations.swap(index, destination);
        }
    }
}
#[derive(Clone, Copy)]
struct Run {
    base: usize,
    len: usize,
}
#[derive(Clone, Copy)]
enum Gallop {
    Left,
    Right,
}
struct State<'a> {
    rows: &'a [ScopeCountViolation],
    work: Vec<usize>,
    temp: Vec<usize>,
    runs: Vec<Run>,
    min_gallop: usize,
}
impl State<'_> {
    fn compare(&self, left: usize, right: usize) -> Ordering {
        let (left, right) = (&self.rows[left], &self.rows[right]);
        right
            .delta
            .abs()
            .partial_cmp(&left.delta.abs())
            .unwrap_or(Ordering::Equal)
            .then_with(|| {
                crate::project::locale_compare_units(left.scope.units(), right.scope.units())
            })
    }
    fn sort(&mut self) {
        let mut n = self.work.len();
        let mut remainder = 0;
        while n >= 64 {
            remainder |= n & 1;
            n >>= 1;
        }
        let min_run = n + remainder;
        let mut low = 0;
        while low < self.work.len() {
            let mut length = self.make_run(low);
            if length < min_run {
                let forced = min_run.min(self.work.len() - low);
                self.binary_insertion(low, low + length, low + forced);
                length = forced;
            }
            self.runs.push(Run {
                base: low,
                len: length,
            });
            self.collapse();
            low += length;
        }
        while self.runs.len() > 1 {
            let mut index = self.runs.len() - 2;
            if index > 0 && self.runs[index - 1].len < self.runs[index + 1].len {
                index -= 1;
            }
            self.merge_at(index);
        }
    }
    fn make_run(&mut self, low: usize) -> usize {
        if low + 1 == self.work.len() {
            return 1;
        }
        let descending = self.compare(self.work[low + 1], self.work[low]).is_lt();
        let mut end = low + 2;
        while end < self.work.len() {
            if self.compare(self.work[end], self.work[end - 1]).is_lt() != descending {
                break;
            }
            end += 1;
        }
        if descending {
            self.work[low..end].reverse();
        }
        end - low
    }
    fn binary_insertion(&mut self, low: usize, start: usize, high: usize) {
        for index in start.max(low + 1)..high {
            let pivot = self.work[index];
            let (mut left, mut right) = (low, index);
            while left < right {
                let middle = left + (right - left) / 2;
                if self.compare(pivot, self.work[middle]).is_lt() {
                    right = middle;
                } else {
                    left = middle + 1;
                }
            }
            self.work[left..=index].rotate_right(1);
        }
    }
    fn invariant(&self, index: usize) -> bool {
        index < 2 || self.runs[index - 2].len > self.runs[index - 1].len + self.runs[index].len
    }
    fn collapse(&mut self) {
        while self.runs.len() > 1 {
            let mut index = self.runs.len() - 2;
            if !self.invariant(index + 1) || !self.invariant(index) {
                if self.runs[index - 1].len < self.runs[index + 1].len {
                    index -= 1;
                }
            } else if self.runs[index].len > self.runs[index + 1].len {
                break;
            }
            self.merge_at(index);
        }
    }
    fn merge_at(&mut self, index: usize) {
        let (mut a, b) = (self.runs[index], self.runs[index + 1]);
        self.runs[index].len = a.len + b.len;
        self.runs.remove(index + 1);
        let skipped = self.gallop(
            Gallop::Right,
            &self.work,
            self.work[b.base],
            a.base,
            a.len,
            0,
        );
        a.base += skipped;
        a.len -= skipped;
        if a.len == 0 {
            return;
        }
        let length_b = self.gallop(
            Gallop::Left,
            &self.work,
            self.work[a.base + a.len - 1],
            b.base,
            b.len,
            b.len - 1,
        );
        if length_b == 0 {
            return;
        }
        if a.len <= length_b {
            self.merge_low(a.base, a.len, b.base, length_b);
        } else {
            self.merge_high(a.base, a.len, b.base, length_b);
        }
    }
    fn gallop(
        &self,
        side: Gallop,
        array: &[usize],
        key: usize,
        base: usize,
        length: usize,
        hint: usize,
    ) -> usize {
        let before = |index: usize| match side {
            Gallop::Left => self.compare(array[base + index], key).is_lt(),
            Gallop::Right => !self.compare(key, array[base + index]).is_lt(),
        };
        let (mut last, mut offset) = (0isize, 1usize);
        if before(hint) {
            let maximum = length - hint;
            while offset < maximum && before(hint + offset) {
                last = offset as isize;
                offset = offset.saturating_mul(2).saturating_add(1);
            }
            offset = offset.min(maximum);
            last += hint as isize;
            offset += hint;
        } else {
            let maximum = hint + 1;
            while offset < maximum && !before(hint - offset) {
                last = offset as isize;
                offset = offset.saturating_mul(2).saturating_add(1);
            }
            offset = offset.min(maximum);
            let previous = last;
            last = hint as isize - offset as isize;
            offset = hint - previous as usize;
        }
        let mut left = (last + 1) as usize;
        while left < offset {
            let middle = left + (offset - left) / 2;
            if before(middle) {
                left = middle + 1;
            } else {
                offset = middle;
            }
        }
        offset
    }
    fn merge_low(
        &mut self,
        base_a: usize,
        mut length_a: usize,
        base_b: usize,
        mut length_b: usize,
    ) {
        self.temp.clear();
        self.temp
            .extend_from_slice(&self.work[base_a..base_a + length_a]);
        let (mut destination, mut cursor_a, mut cursor_b) = (base_a, 0, base_b);
        self.work[destination] = self.work[cursor_b];
        destination += 1;
        cursor_b += 1;
        length_b -= 1;
        let mut minimum = self.min_gallop;
        'merge: while length_a > 1 && length_b > 0 {
            let (mut wins_a, mut wins_b) = (0, 0);
            loop {
                if self
                    .compare(self.work[cursor_b], self.temp[cursor_a])
                    .is_lt()
                {
                    self.work[destination] = self.work[cursor_b];
                    destination += 1;
                    cursor_b += 1;
                    length_b -= 1;
                    wins_b += 1;
                    wins_a = 0;
                    if length_b == 0 {
                        break 'merge;
                    }
                    if wins_b >= minimum {
                        break;
                    }
                } else {
                    self.work[destination] = self.temp[cursor_a];
                    destination += 1;
                    cursor_a += 1;
                    length_a -= 1;
                    wins_a += 1;
                    wins_b = 0;
                    if length_a == 1 {
                        break 'merge;
                    }
                    if wins_a >= minimum {
                        break;
                    }
                }
            }
            minimum += 1;
            let mut first = true;
            while wins_a >= 7 || wins_b >= 7 || first {
                first = false;
                minimum = minimum.saturating_sub(1).max(1);
                self.min_gallop = minimum;
                wins_a = self.gallop(
                    Gallop::Right,
                    &self.temp,
                    self.work[cursor_b],
                    cursor_a,
                    length_a,
                    0,
                );
                if wins_a > 0 {
                    self.work[destination..destination + wins_a]
                        .copy_from_slice(&self.temp[cursor_a..cursor_a + wins_a]);
                    destination += wins_a;
                    cursor_a += wins_a;
                    length_a -= wins_a;
                    if length_a <= 1 {
                        break 'merge;
                    }
                }
                self.work[destination] = self.work[cursor_b];
                destination += 1;
                cursor_b += 1;
                length_b -= 1;
                if length_b == 0 {
                    break 'merge;
                }
                wins_b = self.gallop(
                    Gallop::Left,
                    &self.work,
                    self.temp[cursor_a],
                    cursor_b,
                    length_b,
                    0,
                );
                if wins_b > 0 {
                    self.work
                        .copy_within(cursor_b..cursor_b + wins_b, destination);
                    destination += wins_b;
                    cursor_b += wins_b;
                    length_b -= wins_b;
                    if length_b == 0 {
                        break 'merge;
                    }
                }
                self.work[destination] = self.temp[cursor_a];
                destination += 1;
                cursor_a += 1;
                length_a -= 1;
                if length_a == 1 {
                    break 'merge;
                }
            }
            minimum += 1;
            self.min_gallop = minimum;
        }
        if length_a == 1 && length_b > 0 {
            self.work
                .copy_within(cursor_b..cursor_b + length_b, destination);
            self.work[destination + length_b] = self.temp[cursor_a];
        } else if length_a > 0 {
            self.work[destination..destination + length_a]
                .copy_from_slice(&self.temp[cursor_a..cursor_a + length_a]);
        }
    }
    fn merge_high(
        &mut self,
        base_a: usize,
        mut length_a: usize,
        base_b: usize,
        mut length_b: usize,
    ) {
        self.temp.clear();
        self.temp
            .extend_from_slice(&self.work[base_b..base_b + length_b]);
        let (mut destination, mut cursor_a, mut cursor_b) =
            (base_b + length_b, base_a + length_a, length_b);
        destination -= 1;
        cursor_a -= 1;
        self.work[destination] = self.work[cursor_a];
        length_a -= 1;
        let mut minimum = self.min_gallop;
        'merge: while length_a > 0 && length_b > 1 {
            let (mut wins_a, mut wins_b) = (0, 0);
            loop {
                if self
                    .compare(self.temp[cursor_b - 1], self.work[cursor_a - 1])
                    .is_lt()
                {
                    destination -= 1;
                    cursor_a -= 1;
                    self.work[destination] = self.work[cursor_a];
                    length_a -= 1;
                    wins_a += 1;
                    wins_b = 0;
                    if length_a == 0 {
                        break 'merge;
                    }
                    if wins_a >= minimum {
                        break;
                    }
                } else {
                    destination -= 1;
                    cursor_b -= 1;
                    self.work[destination] = self.temp[cursor_b];
                    length_b -= 1;
                    wins_b += 1;
                    wins_a = 0;
                    if length_b == 1 {
                        break 'merge;
                    }
                    if wins_b >= minimum {
                        break;
                    }
                }
            }
            minimum += 1;
            let mut first = true;
            while wins_a >= 7 || wins_b >= 7 || first {
                first = false;
                minimum = minimum.saturating_sub(1).max(1);
                self.min_gallop = minimum;
                let split = self.gallop(
                    Gallop::Right,
                    &self.work,
                    self.temp[cursor_b - 1],
                    base_a,
                    length_a,
                    length_a - 1,
                );
                wins_a = length_a - split;
                if wins_a > 0 {
                    destination -= wins_a;
                    cursor_a -= wins_a;
                    self.work
                        .copy_within(cursor_a..cursor_a + wins_a, destination);
                    length_a -= wins_a;
                    if length_a == 0 {
                        break 'merge;
                    }
                }
                destination -= 1;
                cursor_b -= 1;
                self.work[destination] = self.temp[cursor_b];
                length_b -= 1;
                if length_b == 1 {
                    break 'merge;
                }
                let split = self.gallop(
                    Gallop::Left,
                    &self.temp,
                    self.work[cursor_a - 1],
                    0,
                    length_b,
                    length_b - 1,
                );
                wins_b = length_b - split;
                if wins_b > 0 {
                    destination -= wins_b;
                    cursor_b -= wins_b;
                    self.work[destination..destination + wins_b]
                        .copy_from_slice(&self.temp[cursor_b..cursor_b + wins_b]);
                    length_b -= wins_b;
                    if length_b <= 1 {
                        break 'merge;
                    }
                }
                destination -= 1;
                cursor_a -= 1;
                self.work[destination] = self.work[cursor_a];
                length_a -= 1;
                if length_a == 0 {
                    break 'merge;
                }
            }
            minimum += 1;
            self.min_gallop = minimum;
        }
        if length_b == 1 && length_a > 0 {
            destination -= length_a;
            cursor_a -= length_a;
            self.work
                .copy_within(cursor_a..cursor_a + length_a, destination);
            self.work[destination - 1] = self.temp[cursor_b - 1];
        } else if length_b > 0 {
            self.work[destination - length_b..destination].copy_from_slice(&self.temp[..length_b]);
        }
    }
}
