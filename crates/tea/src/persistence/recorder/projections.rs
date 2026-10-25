use super::Trace;
use crate::{
    Tagged,
    data::{JsText, JsonData, plain_data},
};
use serde::Serialize;
use std::{convert::Infallible, sync::Arc};
#[derive(Debug)]
pub struct BreadcrumbData<M> {
    pub msg: Arc<M>,
}
#[derive(Debug)]
pub struct Breadcrumb<M, R = JsText> {
    pub category: &'static str,
    pub kind: &'static str,
    pub level: &'static str,
    pub message: R,
    pub data: BreadcrumbData<M>,
}
pub fn breadcrumbs_from_trace_with<S, M, R, E>(
    trace: &Trace<S, M>,
    limit: Option<f64>,
    mut render: impl FnMut(&M) -> Result<R, E>,
) -> Result<Vec<Breadcrumb<M, R>>, E> {
    let limit = match limit {
        None => 100.0,
        Some(value) if value.is_nan() => 100.0,
        Some(value) => value.floor().max(0.0),
    };
    let start = if limit >= trace.msgs.len() as f64 {
        0
    } else {
        trace.msgs.len() - limit as usize
    };
    let mut result = Vec::new();
    for msg in &trace.msgs[start..] {
        result.push(Breadcrumb {
            category: "tea",
            kind: "default",
            level: "info",
            message: render(msg)?,
            data: BreadcrumbData {
                msg: Arc::clone(msg),
            },
        });
    }
    Ok(result)
}
pub fn breadcrumbs_from_trace<S, M: Tagged>(
    trace: &Trace<S, M>,
    limit: Option<f64>,
) -> Vec<Breadcrumb<M>> {
    let result = breadcrumbs_from_trace_with(trace, limit, |msg| {
        Ok::<_, Infallible>(JsText::from(msg.tag()))
    });
    match result {
        Ok(value) => value,
        Err(never) => match never {},
    }
}
impl<M: Serialize, R: Serialize> Serialize for Breadcrumb<M, R> {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        #[derive(Serialize)]
        struct Data<'a, M> {
            msg: &'a Arc<M>,
        }
        #[derive(Serialize)]
        struct Fields<'a, M, R> {
            category: &'a str,
            #[serde(rename = "type")]
            kind: &'a str,
            level: &'a str,
            message: &'a R,
            data: Data<'a, M>,
        }
        let data = plain_data(&Fields {
            category: self.category,
            kind: self.kind,
            level: self.level,
            message: &self.message,
            data: Data {
                msg: &self.data.msg,
            },
        })
        .map_err(serde::ser::Error::custom)?;
        JsonData(&data).serialize(serializer)
    }
}
