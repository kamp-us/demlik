use demlik_code_graph::{
    boundaries::shape::entry_file::first_offending_form, engine::oxc::parse_type_script,
};
use std::path::Path;

#[test]
fn an_entry_reports_its_first_remaining_form_as_exports_are_repaired() {
    let clean = "export { reserve } from './booking'; export type { Receipt } from './receipt';";
    let verdict = |source: &str| {
        let syntax = parse_type_script(Path::new("src/booking/index.ts"), source).unwrap();
        first_offending_form(&syntax)
    };
    assert_eq!(verdict(clean), None);
    assert_eq!(
        verdict(&format!(
            "{clean} export default {{}}; export const extra = 1;"
        )),
        Some("export default")
    );
    assert_eq!(
        verdict(&format!("{clean} export const extra = 1;")),
        Some("declaration")
    );
    assert_eq!(
        verdict(&format!("'use strict'; {clean}")),
        Some("statement")
    );
}
