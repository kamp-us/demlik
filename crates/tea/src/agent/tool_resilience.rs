//! Policy declarations only. The agent refuses this configured profile until
//! the tool ladder's retry/timer verbs are implemented.
use crate::retry_backoff::{AnyRetryPolicy, RetryBudget, RetryPolicy};
use serde::Serialize;

#[derive(Clone, Copy, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolResilience {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub timeout_ms: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub retry: Option<AnyRetryPolicy>,
}
impl ToolResilience {
    pub fn timeout_ms(mut self, value: f64) -> Self {
        self.timeout_ms = Some(value);
        self
    }
    pub fn retry<B: Into<RetryBudget>>(mut self, policy: RetryPolicy<B>) -> Self {
        self.retry = Some(policy.into_any());
        self
    }
}
