// Modified by dsh-ops (https://github.com/T-Auto/dsh-ops): removed the Codex profile, installed-binary, and discovery paths that only the deleted Codex integration and self-updater used.
//! Stable user-directory paths used by the MCP server.

use std::path::PathBuf;

/// Per-user state directories the server resolves once per connection.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ControlPaths {
    /// User home directory.
    pub home: PathBuf,
    /// FastCtx configuration directory.
    pub fastctx_dir: PathBuf,
    /// FastCtx configuration file.
    pub fastctx_config: PathBuf,
    /// Persistent background-job registry and complete output-log directory.
    pub jobs_dir: PathBuf,
}

impl ControlPaths {
    /// Builds paths for a supplied home directory for isolated installs and contract tests.
    pub fn for_home(home: impl Into<PathBuf>) -> Self {
        let home = home.into();
        let fastctx_dir = home.join(".fastctx");
        Self {
            fastctx_config: fastctx_dir.join("config.toml"),
            jobs_dir: fastctx_dir.join("jobs"),
            home,
            fastctx_dir,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::ControlPaths;

    #[test]
    fn fastctx_state_lives_under_the_supplied_home() {
        let home = std::path::PathBuf::from("example-home");
        let paths = ControlPaths::for_home(&home);

        assert_eq!(paths.fastctx_dir, home.join(".fastctx"));
        assert_eq!(
            paths.fastctx_config,
            home.join(".fastctx").join("config.toml")
        );
        assert_eq!(paths.jobs_dir, home.join(".fastctx").join("jobs"));
    }
}
