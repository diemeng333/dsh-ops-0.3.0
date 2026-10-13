// Modified by dsh-ops (https://github.com/T-Auto/dsh-ops): the crate no longer has a TUI mode, so this is only the MCP server and internal child-process entry point.
//! MCP server and internal child-process entry point for fastctx.

use std::process::ExitCode;

#[tokio::main(flavor = "current_thread")]
async fn main() -> ExitCode {
    match fastctx::cli::run().await {
        Ok(code) => code,
        Err(error) => {
            eprintln!("fastctx: {error}");
            ExitCode::FAILURE
        }
    }
}
