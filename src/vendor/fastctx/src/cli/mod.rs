// Modified by dsh-ops (https://github.com/T-Auto/dsh-ops): removed the TUI, Apply/Unapply/Status/Lang/Jobs/UpdateHelper commands and the updater startup hooks, leaving the MCP server as the default command.
//! Command-line parsing for the MCP server and its internal child-process entry points.

use crate::server::ServerOptions;
use clap::{Parser, Subcommand};
use std::process::ExitCode;

/// fastctx MCP server entry point.
#[derive(Debug, Parser)]
#[command(
    name = "fastctx",
    version,
    about = "FastCtx — fast, context-efficient repository tools for AI agents.",
    long_about = "Runs the FastCtx MCP server on stdin/stdout."
)]
pub struct Cli {
    /// Explicit command; omission starts the MCP server.
    #[command(subcommand)]
    command: Option<Command>,
}

/// The server command plus the internal child-process entry points.
#[derive(Debug, Subcommand)]
enum Command {
    /// Force the stdio MCP server.
    Serve {
        /// Publish the five optional shell tools.
        #[arg(long)]
        enable_shell: bool,
        /// Deprecated compatibility flag; replace is always published.
        #[arg(long, hide = true)]
        enable_edit: bool,
    },
    /// Internal Unix detach bootstrap.
    #[cfg(unix)]
    #[command(hide = true)]
    JobBootstrap,
    /// Internal detached background-job supervisor.
    #[command(hide = true)]
    JobHost,
    /// Internal Unix process-group orphan guard.
    #[cfg(unix)]
    #[command(hide = true)]
    JobWatch { pid: u32, started: String },
    /// Internal short-lived control-center detach bootstrap.
    #[command(hide = true)]
    RuntimeBootstrap,
    /// Internal per-user control center.
    #[command(hide = true)]
    RuntimeHost {
        /// Test-only idle override; production bootstraps always use ten minutes.
        #[arg(long, hide = true)]
        idle_timeout_ms: Option<u64>,
        /// Test-only maintenance override; production bootstraps use one minute.
        #[arg(long, hide = true)]
        maintenance_interval_ms: Option<u64>,
    },
}

/// Parses the current process arguments and executes the selected command.
pub async fn run() -> Result<ExitCode, String> {
    run_cli(Cli::parse()).await
}

async fn run_cli(cli: Cli) -> Result<ExitCode, String> {
    match cli.command {
        Some(Command::Serve {
            enable_shell,
            enable_edit: _,
        }) => run_server_with_options(ServerOptions { enable_shell }).await,
        #[cfg(unix)]
        Some(Command::JobBootstrap) => {
            crate::shell::jobs::run_bootstrap_entry()?;
            Ok(ExitCode::SUCCESS)
        }
        Some(Command::JobHost) => {
            crate::shell::jobs::run_host_entry()?;
            Ok(ExitCode::SUCCESS)
        }
        Some(Command::RuntimeBootstrap) => {
            crate::runtime::run_bootstrap_entry()?;
            Ok(ExitCode::SUCCESS)
        }
        Some(Command::RuntimeHost {
            idle_timeout_ms,
            maintenance_interval_ms,
        }) => {
            crate::runtime::run_host_entry(idle_timeout_ms, maintenance_interval_ms).await?;
            Ok(ExitCode::SUCCESS)
        }
        #[cfg(unix)]
        Some(Command::JobWatch { pid, started }) => {
            crate::shell::jobs::run_watchdog_entry(pid, started)?;
            Ok(ExitCode::SUCCESS)
        }
        None => run_server().await,
    }
}

/// Forces stdio MCP server startup for reuse by the entry point and doctor.
pub async fn run_server() -> Result<ExitCode, String> {
    run_server_with_options(ServerOptions::default()).await
}

/// Starts the single server with the requested optional tool groups.
pub async fn run_server_with_options(options: ServerOptions) -> Result<ExitCode, String> {
    let environment = crate::runtime::capture_proxy_environment()?;
    let parent = crate::process_identity::parent_identity_from_environment()?;
    crate::runtime::run_proxy_session(options, environment, parent).await
}
