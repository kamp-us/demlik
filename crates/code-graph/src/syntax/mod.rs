//! Source-position and traversal conventions shared by structural extraction passes.

pub mod bindings;
pub mod file;
pub mod headers;
pub mod imports;
pub mod trivia;

pub use file::{NodeRef, SyntaxFile};
