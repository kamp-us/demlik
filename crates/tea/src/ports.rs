use std::{
    collections::HashSet,
    fmt,
    marker::PhantomData,
    sync::{Arc, Mutex, OnceLock},
};

use crate::data::JsText;

static NAMES: OnceLock<Mutex<HashSet<JsText>>> = OnceLock::new();
#[derive(Debug)]
pub struct PortNameCollisionError {
    pub port_name: JsText,
}
impl PortNameCollisionError {
    pub fn name(&self) -> &'static str {
        "PortNameCollisionError"
    }
    pub fn message(&self) -> JsText {
        let mut units = "definePort: a port named \""
            .encode_utf16()
            .collect::<Vec<_>>();
        units.extend(self.port_name.as_units());
        units.extend("\" was already defined. Each definePort call must use a unique name. If two modules need the same port, export it from one module and import it.".encode_utf16());
        JsText::from_units(units)
    }
}
impl fmt::Display for PortNameCollisionError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let message = self.message();
        match message.as_utf8() {
            Some(message) => f.write_str(message),
            None => write!(
                f,
                "{}",
                serde_json::to_string(&message).map_err(|_| fmt::Error)?
            ),
        }
    }
}
impl std::error::Error for PortNameCollisionError {}
impl serde::Serialize for PortNameCollisionError {
    fn serialize<T: serde::Serializer>(&self, serializer: T) -> Result<T::Ok, T::Error> {
        use serde::ser::SerializeStruct;
        let mut error = serializer.serialize_struct(self.name(), 3)?;
        error.serialize_field("name", self.name())?;
        error.serialize_field("_tag", self.name())?;
        error.serialize_field("message", &self.message())?;
        error.end()
    }
}

pub(crate) struct PortKey {
    name: JsText,
}
/// A declaration's shared reference is its identity; its process-unique name is metadata.
pub struct Port<T> {
    pub(crate) key: Arc<PortKey>,
    value: PhantomData<fn(T) -> T>,
}
impl<T> Clone for Port<T> {
    fn clone(&self) -> Self {
        Self {
            key: Arc::clone(&self.key),
            value: PhantomData,
        }
    }
}
impl<T> Port<T> {
    pub fn name(&self) -> &JsText {
        &self.key.name
    }
    pub(crate) fn id(&self) -> usize {
        Arc::as_ptr(&self.key) as usize
    }
}
impl<T> fmt::Debug for Port<T> {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("Port").field("name", self.name()).finish()
    }
}
pub fn define_port<T>(name: impl Into<JsText>) -> Result<Port<T>, PortNameCollisionError> {
    let name = name.into();
    let mut names = NAMES
        .get_or_init(Mutex::default)
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    if !names.insert(name.clone()) {
        return Err(PortNameCollisionError { port_name: name });
    }
    Ok(Port {
        key: Arc::new(PortKey { name }),
        value: PhantomData,
    })
}
