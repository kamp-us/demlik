//! Provider-neutral text, image and file parts with retained media views.

use crate::data::JsText;
use serde::{Serialize, ser::SerializeMap};
use std::{
    cell::{Cell, RefCell},
    fmt,
    ops::Range,
    rc::Rc,
};

struct ByteView {
    buffer: Rc<[Cell<u8>]>,
    offset: usize,
    len: usize,
}
/// A fixed-size shared byte view. `view` shares storage; `copied` allocates it.
/// Ranges and indices are checked native indices, without JavaScript coercion.
#[derive(Clone)]
pub struct MediaBytes(Rc<ByteView>);
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum MediaBytesError {
    Index {
        index: usize,
        len: usize,
    },
    Range {
        start: usize,
        end: usize,
        len: usize,
    },
}
impl fmt::Display for MediaBytesError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Index { index, len } => {
                write!(f, "byte index {index} is outside view length {len}")
            }
            Self::Range { start, end, len } => {
                write!(f, "byte range {start}..{end} is outside view length {len}")
            }
        }
    }
}
impl std::error::Error for MediaBytesError {}
impl MediaBytes {
    pub fn new(bytes: Vec<u8>) -> Self {
        let len = bytes.len();
        let buffer = bytes.into_iter().map(Cell::new).collect::<Vec<_>>().into();
        Self(Rc::new(ByteView {
            buffer,
            offset: 0,
            len,
        }))
    }
    pub fn len(&self) -> usize {
        self.0.len
    }
    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }
    pub fn offset(&self) -> usize {
        self.0.offset
    }
    pub fn same_view(&self, other: &Self) -> bool {
        Rc::ptr_eq(&self.0, &other.0)
    }
    pub fn shares_buffer(&self, other: &Self) -> bool {
        Rc::ptr_eq(&self.0.buffer, &other.0.buffer)
    }
    pub fn view(&self, range: Range<usize>) -> Result<Self, MediaBytesError> {
        if range.start > range.end || range.end > self.len() {
            return Err(MediaBytesError::Range {
                start: range.start,
                end: range.end,
                len: self.len(),
            });
        }
        Ok(Self(Rc::new(ByteView {
            buffer: Rc::clone(&self.0.buffer),
            offset: self.offset() + range.start,
            len: range.end - range.start,
        })))
    }
    pub fn get(&self, index: usize) -> Result<u8, MediaBytesError> {
        if index >= self.len() {
            return Err(MediaBytesError::Index {
                index,
                len: self.len(),
            });
        }
        Ok(self.0.buffer[self.offset() + index].get())
    }
    pub fn set(&self, index: usize, value: u8) -> Result<(), MediaBytesError> {
        if index >= self.len() {
            return Err(MediaBytesError::Index {
                index,
                len: self.len(),
            });
        }
        self.0.buffer[self.offset() + index].set(value);
        Ok(())
    }
    pub fn to_vec(&self) -> Vec<u8> {
        self.0.buffer[self.offset()..self.offset() + self.len()]
            .iter()
            .map(Cell::get)
            .collect()
    }
    pub fn copied(&self) -> Self {
        Self::new(self.to_vec())
    }
}
impl Serialize for MediaBytes {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        // JSON.stringify(Uint8Array) writes enumerable index properties.
        let mut map = serializer.serialize_map(Some(self.len()))?;
        for (index, byte) in self.to_vec().into_iter().enumerate() {
            map.serialize_entry(&index.to_string(), &byte)?;
        }
        map.end()
    }
}

/// One source variant owns the data or URL, so a mixed source cannot be built.
///
/// ```compile_fail,E0559
/// use demlik_tea::agent::content::MediaSource;
/// let source = MediaSource::Url { url: "https://example.test/a".into(), data: "AAAA".into() };
/// ```
#[derive(Clone, Serialize)]
#[serde(tag = "type", rename_all = "lowercase")]
pub enum MediaSource {
    Base64 { data: JsText },
    Bytes { data: MediaBytes },
    Url { url: JsText },
}
pub struct TextPart {
    pub text: JsText,
}
pub struct ImagePart {
    pub media_type: JsText,
    pub source: Rc<MediaSource>,
}
pub struct FilePart {
    pub media_type: JsText,
    pub source: Rc<MediaSource>,
}
#[derive(Clone, Serialize)]
#[serde(untagged)]
pub enum ContentPart {
    Text(Rc<TextPart>),
    Image(Rc<ImagePart>),
    File(Rc<FilePart>),
}
impl ContentPart {
    pub fn same_identity(&self, other: &Self) -> bool {
        match (self, other) {
            (Self::Text(a), Self::Text(b)) => Rc::ptr_eq(a, b),
            (Self::Image(a), Self::Image(b)) => Rc::ptr_eq(a, b),
            (Self::File(a), Self::File(b)) => Rc::ptr_eq(a, b),
            _ => false,
        }
    }
}
impl Serialize for TextPart {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        let mut map = serializer.serialize_map(Some(2))?;
        map.serialize_entry("type", "text")?;
        map.serialize_entry("text", &self.text)?;
        map.end()
    }
}
macro_rules! media_part {
    ($name:ident, $kind:literal) => {
        impl Serialize for $name {
            fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
                let mut map = serializer.serialize_map(Some(3))?;
                map.serialize_entry("type", $kind)?;
                map.serialize_entry("mediaType", &self.media_type)?;
                map.serialize_entry("source", &self.source)?;
                map.end()
            }
        }
    };
}
media_part!(ImagePart, "image");
media_part!(FilePart, "file");

pub type Parts = Rc<RefCell<Vec<ContentPart>>>;
#[derive(Clone, Serialize)]
#[serde(untagged)]
pub enum MessageContent {
    Text(JsText),
    Parts(Parts),
}
pub fn content_parts(content: &MessageContent) -> Parts {
    match content {
        MessageContent::Text(text) => {
            Rc::new(RefCell::new(vec![ContentPart::Text(Rc::new(TextPart {
                text: text.clone(),
            }))]))
        }
        MessageContent::Parts(parts) => Rc::clone(parts),
    }
}
pub const IMAGE_OMITTED: &str = "[image omitted]";
pub const FILE_OMITTED: &str = "[file omitted]";
pub fn omit_media(parts: &Parts) -> Parts {
    Rc::new(RefCell::new(
        parts
            .borrow()
            .iter()
            .map(|part| match part {
                ContentPart::Text(_) => part.clone(),
                ContentPart::Image(_) => ContentPart::Text(Rc::new(TextPart {
                    text: IMAGE_OMITTED.into(),
                })),
                ContentPart::File(_) => ContentPart::Text(Rc::new(TextPart {
                    text: FILE_OMITTED.into(),
                })),
            })
            .collect(),
    ))
}
