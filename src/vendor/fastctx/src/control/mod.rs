// Modified by dsh-ops (https://github.com/T-Auto/dsh-ops): kept only the paths/settings/transaction modules the MCP server loads, dropping the Codex integration, doctor, and language catalogs.
//! Per-user paths, settings, and atomic file transactions used by the MCP server.

pub mod paths;
pub mod settings;
pub mod transaction;
