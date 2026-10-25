//! Source analysis, graph queries and architecture rules.

pub mod boundaries;
pub mod checker;
pub mod comments;
pub(crate) mod config;
pub mod data;
pub mod declarations;
pub mod engine;
pub mod extract;
pub mod kinds;
pub mod layers;
pub mod project;
pub mod query;
pub mod ratchet;
pub mod render;
pub mod resolve;
pub mod scc;
pub mod schema;
pub mod smells;
pub mod syntax;
pub mod text;
pub mod validation;
