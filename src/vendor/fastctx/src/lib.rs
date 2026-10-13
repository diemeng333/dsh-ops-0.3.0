// Modified by dsh-ops (https://github.com/T-Auto/dsh-ops): dropped the tui and update modules so the crate builds only the MCP server surface.
//! Local MCP toolkit for MCP hosts: default file tools plus an optional bash group.

pub(crate) mod background_status;
pub(crate) mod binary;
pub(crate) mod bounded_sort;
pub mod budget;
pub mod cli;
pub(crate) mod context_guard;
pub mod control;
pub mod edit;
mod edit_server;
pub mod encoding;
pub(crate) mod file_executor;
pub(crate) mod file_snapshot;
pub mod glob_filter;
pub mod glob_tool;
pub(crate) mod grep_sink;
pub mod grep_tool;
pub mod model;
pub(crate) mod model_guidance;
pub(crate) mod operation;
pub(crate) mod ordered_window;
pub(crate) mod os_environment;
pub(crate) mod path_codec;
pub mod paths;
pub(crate) mod process_identity;
pub(crate) mod process_policy;
pub mod read_tool;
pub(crate) mod render_plan;
pub(crate) mod runtime;
pub(crate) mod search_parallelism;
pub(crate) mod search_text;
pub mod server;
pub mod server_manifest;
pub(crate) mod server_support;
pub mod session;
pub mod shell;
mod shell_server;
pub(crate) mod skip_report;
pub(crate) mod stdio_transport;
pub(crate) mod tool_schema;
pub(crate) mod traversal;

pub use model::{ImageDetail, ToolContent, ToolResponse};
