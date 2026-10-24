use demlik_tea::Sub;
use serde_json::json;

#[test]
fn restored_subscriptions_refuse_an_id_that_does_not_match_their_dependencies() {
    let wire = json!({ "id": "same-for-everything", "type": "pulse", "deps": { "count": 1 } });
    assert!(serde_json::from_value::<Sub>(wire).is_err());
}
