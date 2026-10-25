use crate::{
    extract::functions::js_space,
    schema::{DataAccess, DataBindingKind},
    text::JsString,
};

pub fn sql_access(sql: Option<&JsString>) -> DataAccess {
    let keyword = sql.map(|sql| {
        sql.units()
            .iter()
            .copied()
            .skip_while(|unit| char::from_u32(u32::from(*unit)).is_some_and(js_space))
            .take_while(|unit| *unit <= 127 && (*unit as u8).is_ascii_alphabetic())
            .map(|unit| (unit as u8 as char).to_ascii_uppercase())
            .collect::<String>()
    });
    match keyword.as_deref() {
        Some("SELECT") => DataAccess::Read,
        Some("INSERT" | "UPDATE" | "DELETE" | "REPLACE" | "CREATE" | "DROP" | "ALTER") => {
            DataAccess::Write
        }
        _ => DataAccess::Unknown,
    }
}
pub fn access_of(
    kind: DataBindingKind,
    method: Option<&JsString>,
    sql: Option<&JsString>,
) -> DataAccess {
    let Some(method) = method else {
        return DataAccess::Unknown;
    };
    let (read, write): (&[&str], &[&str]) = match kind {
        DataBindingKind::D1 => {
            return if method == "prepare" || method == "exec" {
                sql_access(sql)
            } else if method == "dump" {
                DataAccess::Read
            } else {
                DataAccess::Unknown
            };
        }
        DataBindingKind::Kv => (&["get", "getWithMetadata", "list"], &["put", "delete"]),
        DataBindingKind::R2 => (
            &["get", "head", "list"],
            &[
                "put",
                "delete",
                "createMultipartUpload",
                "resumeMultipartUpload",
            ],
        ),
        DataBindingKind::Queue => (&[], &["send", "sendBatch"]),
        DataBindingKind::DurableObject => (&[], &[]),
    };
    if read.iter().any(|name| method == name) {
        DataAccess::Read
    } else if write.iter().any(|name| method == name) {
        DataAccess::Write
    } else {
        DataAccess::Unknown
    }
}
