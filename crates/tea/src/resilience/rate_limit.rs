use crate::js_math::{max as js_max, min as js_min};
pub use crate::work_queue::QueueTime as BucketNumber;
use serde::{Deserialize, Serialize};

#[derive(Clone, Copy, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TokenBucket {
    pub tokens: BucketNumber,
    pub capacity: BucketNumber,
    pub refill_per_sec: BucketNumber,
    pub last_refill_ms: BucketNumber,
}

pub fn init_bucket(
    capacity: f64,
    refill_per_sec: f64,
    now_ms: impl Into<BucketNumber>,
) -> TokenBucket {
    TokenBucket {
        tokens: capacity.into(),
        capacity: capacity.into(),
        refill_per_sec: refill_per_sec.into(),
        last_refill_ms: now_ms.into(),
    }
}

pub fn refill(bucket: &TokenBucket, now_ms: impl Into<BucketNumber>) -> TokenBucket {
    let now_ms = now_ms.into();
    let elapsed_sec = js_max(
        0.0,
        now_ms.number_or_zero() - bucket.last_refill_ms.number_or_zero(),
    ) / 1000.0;
    let replenished =
        bucket.tokens.number_or_zero() + elapsed_sec * bucket.refill_per_sec.number_or_zero();
    TokenBucket {
        tokens: js_min(bucket.capacity.number_or_zero(), replenished).into(),
        last_refill_ms: now_ms,
        ..*bucket
    }
}

pub fn try_consume(
    bucket: &TokenBucket,
    now_ms: impl Into<BucketNumber>,
    n: f64,
) -> (TokenBucket, bool) {
    let mut next = refill(bucket, now_ms);
    let allowed = next.tokens.number_or_zero() >= n;
    if allowed {
        next.tokens = (next.tokens.number_or_zero() - n).into();
    }
    (next, allowed)
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SlidingWindow {
    pub hits: Vec<f64>,
    pub window_ms: f64,
    pub limit: f64,
}

pub fn init_window(window_ms: f64, limit: f64) -> SlidingWindow {
    SlidingWindow {
        hits: Vec::new(),
        window_ms,
        limit,
    }
}

impl SlidingWindow {
    fn live_hits(&self, now_ms: f64) -> impl Iterator<Item = f64> + '_ {
        let cutoff = now_ms - self.window_ms;
        self.hits.iter().copied().filter(move |hit| *hit > cutoff)
    }
}

pub fn record(window: &SlidingWindow, now_ms: f64) -> (SlidingWindow, bool) {
    let mut hits: Vec<_> = window.live_hits(now_ms).collect();
    let allowed = (hits.len() as f64) < window.limit;
    if allowed {
        hits.push(now_ms);
    }
    (
        SlidingWindow {
            hits,
            window_ms: window.window_ms,
            limit: window.limit,
        },
        allowed,
    )
}

pub fn remaining(window: &SlidingWindow, now_ms: f64) -> f64 {
    js_max(0.0, window.limit - window.live_hits(now_ms).count() as f64)
}
