// Modified by dsh-ops (https://github.com/T-Auto/dsh-ops): dropped the update/language/applied-record/TUI-only settings and the startup-normalization writer, keeping the job, replace, search, and tool-budget settings the MCP server loads.
//! Stable format and atomic I/O for `~/.fastctx/config.toml`.

use crate::control::paths::ControlPaths;
use crate::control::transaction;
use crate::search_parallelism::{self, SearchParallelism};
use serde::{Deserialize, Serialize};
use std::fmt;
use std::fs;
use std::path::Path;

const CURRENT_SCHEMA_VERSION: u32 = 1;
const LEGACY_SCHEMA_VERSION: u32 = 0;
/// Default current-user disk allowance for retained background-job records.
pub const DEFAULT_JOB_STORAGE_LIMIT_MIB: u64 = 1_024;
/// Default current-user number of simultaneously running background jobs.
pub const DEFAULT_MAX_RUNNING_JOBS: u64 = 128;
/// Default number of background-job records returned by one `job_list` call.
pub const DEFAULT_JOB_LIST_LIMIT: u64 = 20;
/// Largest configurable page size accepted by `job_list`.
pub const MAX_JOB_LIST_LIMIT: u64 = 100;
/// Default replace input and output safety limit in MiB.
pub const DEFAULT_REPLACE_FILE_LIMIT_MIB: i64 = 256;
/// Smallest replace safety limit accepted by the control plane.
pub const MIN_REPLACE_FILE_LIMIT_MIB: i64 = 64;
/// Largest replace safety limit offered by the control plane.
pub const MAX_REPLACE_FILE_LIMIT_MIB: i64 = 4_096;

/// Current-user grep/glob CPU settings, read when the shared control center starts.
#[derive(Clone, Copy, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
#[serde(default)]
pub struct SearchSettings {
    /// Maximum CPU lanes including the request-local base lane; omission keeps automatic mode.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub max_cpu_cores: Option<i64>,
}

impl SearchSettings {
    fn is_default(&self) -> bool {
        self.max_cpu_cores.is_none()
    }
}

/// Current-user replace memory-safety settings, reloaded for every request.
#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(default)]
pub struct ReplaceSettings {
    /// Maximum size of both an input file and its replacement result, in MiB.
    pub max_file_size_mib: i64,
}

impl ReplaceSettings {
    fn is_default(&self) -> bool {
        *self == Self::default()
    }

    /// Resolves a persisted limit without silently clamping an invalid user choice.
    pub(crate) fn resolved_file_limit_mib(self) -> Result<u64, String> {
        if !(MIN_REPLACE_FILE_LIMIT_MIB..=MAX_REPLACE_FILE_LIMIT_MIB)
            .contains(&self.max_file_size_mib)
        {
            return Err(format!(
                "replace.max_file_size_mib must be a whole number from {MIN_REPLACE_FILE_LIMIT_MIB}..={MAX_REPLACE_FILE_LIMIT_MIB} MiB"
            ));
        }
        Ok(self.max_file_size_mib as u64)
    }
}

impl Default for ReplaceSettings {
    fn default() -> Self {
        Self {
            max_file_size_mib: DEFAULT_REPLACE_FILE_LIMIT_MIB,
        }
    }
}

/// Codex host output tier.
#[derive(Clone, Copy, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum Tier {
    /// Conservative 20k host limit with an 18k FastCtx budget.
    Compact,
    /// Recommended 60k host limit with a 54k FastCtx budget.
    #[default]
    Standard,
    /// Widest 100k host limit with a 90k FastCtx budget.
    #[serde(alias = "extra-high")]
    High,
}

impl Tier {
    /// Host token limit written to Codex.
    pub const fn host_limit(self) -> i64 {
        match self {
            Self::Compact => 20_000,
            Self::Standard => 60_000,
            Self::High => 100_000,
        }
    }

    /// Global token budget written to the FastCtx environment, ten percent below the host limit.
    pub const fn fastctx_budget(self) -> usize {
        match self {
            Self::Compact => 18_000,
            Self::Standard => 54_000,
            Self::High => 90_000,
        }
    }

    /// Recommended per-tool shares for this tier, used wherever the user set no explicit share.
    ///
    /// Only `read` scales with the tier: it is the one tool asked to deliver a whole file at once,
    /// so a wider tier exists precisely to widen it. The other four deliver excerpts, listings,
    /// summaries, or output that also survives on disk, and their useful size barely moves between
    /// tiers, so their shares shrink as the global budget grows. Each tool's resolved absolute
    /// budget still rises monotonically from Compact to High; `tier_defaults_grow_with_the_tier`
    /// fails if a future edit breaks that.
    pub const fn default_budgets(self) -> ToolBudgets {
        match self {
            Self::Compact => ToolBudgets {
                read: ToolBudgetLevel::Inherit,
                grep: ToolBudgetLevel::Percent(50),
                glob: ToolBudgetLevel::Percent(25),
                run: ToolBudgetLevel::Percent(50),
                job_output: ToolBudgetLevel::Percent(25),
            },
            Self::Standard => ToolBudgets {
                read: ToolBudgetLevel::Inherit,
                grep: ToolBudgetLevel::Percent(20),
                glob: ToolBudgetLevel::Percent(10),
                run: ToolBudgetLevel::Percent(20),
                job_output: ToolBudgetLevel::Percent(10),
            },
            Self::High => ToolBudgets {
                read: ToolBudgetLevel::Inherit,
                grep: ToolBudgetLevel::Percent(12),
                glob: ToolBudgetLevel::Percent(6),
                run: ToolBudgetLevel::Percent(12),
                job_output: ToolBudgetLevel::Percent(6),
            },
        }
    }
}

/// One tool's share of the global budget, as a whole percent.
///
/// A full share is `Inherit` rather than `Percent(100)`: it omits the per-tool environment
/// variable entirely so the server falls back to the global budget, which also keeps budget
/// errors pointing at the global variable instead of an equal per-tool one.
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub enum ToolBudgetLevel {
    /// Omit the per-tool environment variable so the server inherits the global value.
    #[default]
    Inherit,
    /// Explicit share between 1 and 99 percent of the global budget.
    Percent(u8),
}

impl ToolBudgetLevel {
    /// Builds a share from a whole percent, normalizing a full share to inheritance.
    ///
    /// Rejects anything outside `1..=100`; a zero share resolves to a budget the server refuses.
    pub const fn from_percent(percent: u8) -> Option<Self> {
        if percent == 0 || percent > 100 {
            None
        } else if percent == 100 {
            Some(Self::Inherit)
        } else {
            Some(Self::Percent(percent))
        }
    }

    /// Returns the concrete budget to write, or `None` for inheritance.
    pub const fn resolve(self, global: usize) -> Option<usize> {
        let percent = match self {
            Self::Inherit => return None,
            Self::Percent(percent) => percent as usize,
        };
        let raw = (global * percent + 50) / 100;
        let rounded = ((raw + 50) / 100) * 100;
        // Rounding to hundreds reaches zero for a small share of a small budget, and the server
        // rejects a zero budget outright, so keep the smallest representable step instead.
        Some(if rounded == 0 { 100 } else { rounded })
    }

    /// Parses a configuration-file spelling.
    ///
    /// The four fixed names are what releases before arbitrary percentages wrote, so they stay
    /// readable forever; `"17%"` is accepted too because that is how the UI shows a share and
    /// therefore how someone hand-editing the file will most likely spell it.
    fn from_config_str(value: &str) -> Option<Self> {
        match value.trim() {
            "inherit" => Some(Self::Inherit),
            "percent75" => Some(Self::Percent(75)),
            "percent50" => Some(Self::Percent(50)),
            "percent25" => Some(Self::Percent(25)),
            other => Self::from_percent(other.strip_suffix('%')?.trim().parse().ok()?),
        }
    }
}

impl Serialize for ToolBudgetLevel {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        // Shares an older release can still parse keep their legacy spelling so a downgrade reads
        // the file back instead of failing on an unrecognized shape. Only a share that older
        // releases could never express falls through to the numeric form. (2026-07-25)
        match self {
            Self::Inherit => serializer.serialize_str("inherit"),
            Self::Percent(75) => serializer.serialize_str("percent75"),
            Self::Percent(50) => serializer.serialize_str("percent50"),
            Self::Percent(25) => serializer.serialize_str("percent25"),
            Self::Percent(percent) => serializer.serialize_u8(*percent),
        }
    }
}

impl<'de> Deserialize<'de> for ToolBudgetLevel {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        deserializer.deserialize_any(ToolBudgetLevelVisitor)
    }
}

struct ToolBudgetLevelVisitor;

impl serde::de::Visitor<'_> for ToolBudgetLevelVisitor {
    type Value = ToolBudgetLevel;

    fn expecting(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("\"inherit\" or a whole percent between 1 and 100")
    }

    fn visit_str<E>(self, value: &str) -> Result<Self::Value, E>
    where
        E: serde::de::Error,
    {
        ToolBudgetLevel::from_config_str(value)
            .ok_or_else(|| E::invalid_value(serde::de::Unexpected::Str(value), &self))
    }

    fn visit_u64<E>(self, value: u64) -> Result<Self::Value, E>
    where
        E: serde::de::Error,
    {
        u8::try_from(value)
            .ok()
            .and_then(ToolBudgetLevel::from_percent)
            .ok_or_else(|| E::invalid_value(serde::de::Unexpected::Unsigned(value), &self))
    }

    fn visit_i64<E>(self, value: i64) -> Result<Self::Value, E>
    where
        E: serde::de::Error,
    {
        let unsigned = u64::try_from(value)
            .map_err(|_| E::invalid_value(serde::de::Unexpected::Signed(value), &self))?;
        self.visit_u64(unsigned)
    }
}

/// The five long-output tools' shares in effect for one Apply.
#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(default)]
pub struct ToolBudgets {
    /// Share for read.
    pub read: ToolBudgetLevel,
    /// Share for grep.
    pub grep: ToolBudgetLevel,
    /// Share for glob.
    pub glob: ToolBudgetLevel,
    /// Share for run; effective only when the shell group is enabled.
    pub run: ToolBudgetLevel,
    /// Share for job_output; effective only when the shell group is enabled.
    pub job_output: ToolBudgetLevel,
}

/// Per-tool shares the user set explicitly; every unset entry follows the selected tier.
///
/// Keeping "unset" distinct from an equal explicit share is what lets a tier change re-target the
/// budgets nobody touched while preserving the ones somebody did. Collapsing the two would leave
/// only bad options: either a tier change silently discards explicit shares, or one edit freezes
/// that tool at a share chosen for a different global budget.
#[derive(Clone, Copy, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
#[serde(default)]
pub struct ToolBudgetPreferences {
    /// Explicit share for read, or `None` to follow the tier.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub read: Option<ToolBudgetLevel>,
    /// Explicit share for grep, or `None` to follow the tier.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub grep: Option<ToolBudgetLevel>,
    /// Explicit share for glob, or `None` to follow the tier.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub glob: Option<ToolBudgetLevel>,
    /// Explicit share for run, or `None` to follow the tier.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub run: Option<ToolBudgetLevel>,
    /// Explicit share for job_output, or `None` to follow the tier.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub job_output: Option<ToolBudgetLevel>,
}

impl ToolBudgetPreferences {
    /// Fills every unset entry from the tier's recommended shares.
    pub fn resolve(self, tier: Tier) -> ToolBudgets {
        let defaults = tier.default_budgets();
        ToolBudgets {
            read: self.read.unwrap_or(defaults.read),
            grep: self.grep.unwrap_or(defaults.grep),
            glob: self.glob.unwrap_or(defaults.glob),
            run: self.run.unwrap_or(defaults.run),
            job_output: self.job_output.unwrap_or(defaults.job_output),
        }
    }

    fn is_default(&self) -> bool {
        *self == Self::default()
    }
}

/// Current-user background-job limits.
#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(default)]
pub struct FastShellSettings {
    /// Whether the next Apply should publish the shell tools.
    pub enabled: bool,
    /// Maximum total size of the persistent job registry before terminal records are reaped.
    #[serde(deserialize_with = "deserialize_job_storage_limit")]
    pub job_storage_limit_mib: u64,
    /// Maximum number of background jobs running across all FastCtx sessions.
    #[serde(deserialize_with = "deserialize_max_running_jobs")]
    pub max_running_jobs: u64,
    /// Default maximum records returned by `job_list`; explicit tool arguments override it once.
    #[serde(deserialize_with = "deserialize_job_list_limit")]
    pub job_list_limit: u64,
}

impl Default for FastShellSettings {
    fn default() -> Self {
        Self {
            enabled: false,
            job_storage_limit_mib: DEFAULT_JOB_STORAGE_LIMIT_MIB,
            max_running_jobs: DEFAULT_MAX_RUNNING_JOBS,
            job_list_limit: DEFAULT_JOB_LIST_LIMIT,
        }
    }
}

fn deserialize_job_storage_limit<'de, D>(deserializer: D) -> Result<u64, D::Error>
where
    D: serde::Deserializer<'de>,
{
    deserialize_positive_or_default(deserializer, DEFAULT_JOB_STORAGE_LIMIT_MIB)
}

fn deserialize_max_running_jobs<'de, D>(deserializer: D) -> Result<u64, D::Error>
where
    D: serde::Deserializer<'de>,
{
    deserialize_positive_or_default(deserializer, DEFAULT_MAX_RUNNING_JOBS)
}

fn deserialize_job_list_limit<'de, D>(deserializer: D) -> Result<u64, D::Error>
where
    D: serde::Deserializer<'de>,
{
    let value = serde_json::Value::deserialize(deserializer)?;
    Ok(value
        .as_u64()
        .filter(|value| (1..=MAX_JOB_LIST_LIMIT).contains(value))
        .unwrap_or(DEFAULT_JOB_LIST_LIMIT))
}

fn deserialize_positive_or_default<'de, D>(deserializer: D, fallback: u64) -> Result<u64, D::Error>
where
    D: serde::Deserializer<'de>,
{
    let value = serde_json::Value::deserialize(deserializer)?;
    Ok(value
        .as_u64()
        .filter(|value| *value > 0)
        .unwrap_or(fallback))
}

impl Default for ToolBudgets {
    fn default() -> Self {
        Tier::default().default_budgets()
    }
}

/// FastCtx's own configuration.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(default)]
pub struct FastCtxSettings {
    /// Configuration format version.
    pub schema_version: u32,
    /// Software-version watermark retained from releases that normalized it at startup.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_seen_version: Option<String>,
    /// Per-tool budget-defaults generation retained from releases that normalized it at startup.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tool_budget_epoch: Option<u32>,
    /// Host tier used to resolve the per-tool shares.
    pub tier: Tier,
    /// Advanced per-tool overrides; unset entries follow the tier.
    #[serde(skip_serializing_if = "ToolBudgetPreferences::is_default")]
    pub tool_budgets: ToolBudgetPreferences,
    /// Optional fastshell server, disabled by default.
    pub fastshell: FastShellSettings,
    /// Current-user grep/glob CPU limit, effective after the shared control center restarts.
    #[serde(skip_serializing_if = "SearchSettings::is_default")]
    pub search: SearchSettings,
    /// Current-user replace input and result limit, effective on the next replace request.
    #[serde(skip_serializing_if = "ReplaceSettings::is_default")]
    pub replace: ReplaceSettings,
}

impl Default for FastCtxSettings {
    fn default() -> Self {
        Self {
            schema_version: CURRENT_SCHEMA_VERSION,
            last_seen_version: None,
            tool_budget_epoch: None,
            tier: Tier::Standard,
            tool_budgets: ToolBudgetPreferences::default(),
            fastshell: FastShellSettings::default(),
            search: SearchSettings::default(),
            replace: ReplaceSettings::default(),
        }
    }
}

/// Loads FastCtx configuration, returning defaults when the file does not exist.
pub fn load(paths: &ControlPaths) -> Result<FastCtxSettings, String> {
    load_from(&paths.fastctx_config)
}

impl FastCtxSettings {
    /// Resolves the effective search parallelism or rejects an invalid explicit limit.
    pub(crate) fn search_parallelism(&self) -> Result<SearchParallelism, String> {
        search_parallelism::resolve(self.search.max_cpu_cores)
            .map_err(|error| format!("search.max_cpu_cores {error}"))
    }

    /// Resolves the replace limit or reports the exact persisted key that needs repair.
    pub(crate) fn replace_file_limit_mib(&self) -> Result<u64, String> {
        self.replace.resolved_file_limit_mib()
    }
}

fn search_parallelism_repair_hint() -> String {
    format!(
        "For search.max_cpu_cores, use a whole number from 1..={} or remove the key for automatic mode. ",
        search_parallelism::detected_available()
    )
}

fn replace_limit_repair_hint() -> String {
    format!(
        "For replace.max_file_size_mib, use a whole number from {MIN_REPLACE_FILE_LIMIT_MIB}..={MAX_REPLACE_FILE_LIMIT_MIB} MiB. "
    )
}

fn source_mentions_search_parallelism(source: &str) -> bool {
    let mut in_search_table = false;
    for line in source.lines() {
        let line = line.split('#').next().unwrap_or_default().trim();
        if line.starts_with('[') {
            in_search_table = line == "[search]";
            continue;
        }
        let Some((key, _value)) = line.split_once('=') else {
            continue;
        };
        let key = key.trim();
        if key == "search.max_cpu_cores" || (in_search_table && key == "max_cpu_cores") {
            return true;
        }
    }
    false
}

fn source_mentions_replace_limit(source: &str) -> bool {
    let mut in_replace_table = false;
    for line in source.lines() {
        let line = line.split('#').next().unwrap_or_default().trim();
        if line.starts_with('[') {
            in_replace_table = line == "[replace]";
            continue;
        }
        let Some((key, _value)) = line.split_once('=') else {
            continue;
        };
        let key = key.trim();
        if key == "replace.max_file_size_mib" || (in_replace_table && key == "max_file_size_mib") {
            return true;
        }
    }
    false
}

fn validate_search_parallelism_type(
    document: &toml_edit::DocumentMut,
    path: &Path,
) -> Result<(), String> {
    let Some(search) = document.get("search") else {
        return Ok(());
    };
    let Some(table) = search.as_table_like() else {
        return Err(format!(
            "Cannot parse fastctx settings {}: search must be a table. {}Repair the file and retry.",
            crate::paths::display_path(path),
            search_parallelism_repair_hint()
        ));
    };
    if table
        .get("max_cpu_cores")
        .is_some_and(|value| value.as_integer().is_none())
    {
        return Err(format!(
            "Cannot parse fastctx settings {}: search.max_cpu_cores must be an integer. {}Repair the file and retry.",
            crate::paths::display_path(path),
            search_parallelism_repair_hint()
        ));
    }
    Ok(())
}

fn validate_replace_limit_type(
    document: &toml_edit::DocumentMut,
    path: &Path,
) -> Result<(), String> {
    let Some(replace) = document.get("replace") else {
        return Ok(());
    };
    let Some(table) = replace.as_table_like() else {
        return Err(format!(
            "Cannot parse fastctx settings {}: replace must be a table. {}Repair the file and retry.",
            crate::paths::display_path(path),
            replace_limit_repair_hint()
        ));
    };
    if table
        .get("max_file_size_mib")
        .is_some_and(|value| value.as_integer().is_none())
    {
        return Err(format!(
            "Cannot parse fastctx settings {}: replace.max_file_size_mib must be an integer. {}Repair the file and retry.",
            crate::paths::display_path(path),
            replace_limit_repair_hint()
        ));
    }
    Ok(())
}

/// Loads configuration from a supplied path for tests and migrations.
pub fn load_from(path: &Path) -> Result<FastCtxSettings, String> {
    let source = match fs::read_to_string(path) {
        Ok(source) => source,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Ok(FastCtxSettings::default());
        }
        Err(error) => {
            return Err(format!(
                "Cannot read fastctx settings {}: {error}",
                crate::paths::display_path(path)
            ));
        }
    };
    decode_source(path, &source)
}

fn decode_source(path: &Path, source: &str) -> Result<FastCtxSettings, String> {
    let document = source.parse::<toml_edit::DocumentMut>().map_err(|error| {
        let mut hint = String::new();
        if source_mentions_search_parallelism(source) {
            hint.push_str(&search_parallelism_repair_hint());
        }
        if source_mentions_replace_limit(source) {
            hint.push_str(&replace_limit_repair_hint());
        }
        format!(
            "Cannot parse fastctx settings {}: {error}. {hint}Repair or remove the file and retry.",
            crate::paths::display_path(path)
        )
    })?;
    let schema_version = document
        .get("schema_version")
        .ok_or_else(|| {
            format!(
                "Cannot parse fastctx settings {}: schema_version is missing. Repair or remove the file and retry.",
                crate::paths::display_path(path)
            )
        })?
        .as_integer()
        .and_then(|value| u32::try_from(value).ok())
        .ok_or_else(|| {
            format!(
                "Cannot parse fastctx settings {}: schema_version must be a non-negative integer. Repair the file and retry.",
                crate::paths::display_path(path)
            )
        })?;
    if schema_version > CURRENT_SCHEMA_VERSION {
        return Err(format!(
            "Cannot write fastctx settings {}: schema_version {} was written by a newer fastctx. Upgrade fastctx and retry.",
            crate::paths::display_path(path),
            schema_version
        ));
    }
    if !matches!(
        schema_version,
        LEGACY_SCHEMA_VERSION | CURRENT_SCHEMA_VERSION
    ) {
        return Err(format!(
            "Unsupported fastctx settings schema_version {schema_version} in {}. Upgrade fastctx or repair the file.",
            crate::paths::display_path(path)
        ));
    }
    validate_search_parallelism_type(&document, path)?;
    validate_replace_limit_type(&document, path)?;
    let mut settings: FastCtxSettings = toml_edit::de::from_str(source).map_err(|error| {
        format!(
            "Cannot parse fastctx settings {}: {error}. Repair or remove the file and retry.",
            crate::paths::display_path(path)
        )
    })?;
    if schema_version == LEGACY_SCHEMA_VERSION {
        settings.schema_version = CURRENT_SCHEMA_VERSION;
    }
    Ok(settings)
}

/// Encodes configuration as stable UTF-8 TOML.
pub fn encode(settings: &FastCtxSettings) -> Result<Vec<u8>, String> {
    if settings.schema_version != CURRENT_SCHEMA_VERSION {
        return Err(format!(
            "Refusing to write fastctx settings schema_version {}; this fastctx only writes schema_version {CURRENT_SCHEMA_VERSION}.",
            settings.schema_version
        ));
    }
    settings
        .search_parallelism()
        .map_err(|error| format!("Cannot encode fastctx settings: {error}."))?;
    settings
        .replace_file_limit_mib()
        .map_err(|error| format!("Cannot encode fastctx settings: {error}."))?;
    let mut source = toml_edit::ser::to_string_pretty(settings)
        .map_err(|error| format!("Cannot encode fastctx settings: {error}"))?;
    if !source.ends_with('\n') {
        source.push('\n');
    }
    Ok(source.into_bytes())
}

/// Atomically saves FastCtx configuration.
pub fn save(paths: &ControlPaths, settings: &FastCtxSettings) -> Result<bool, String> {
    let bytes = encode(settings)?;
    let original = transaction::read_snapshot(&paths.fastctx_config)?;
    if original.as_deref() == Some(bytes.as_slice()) {
        crate::shell::jobs::reap(paths).map_err(|error| {
            format!(
                "Settings were unchanged, but finished job records could not be reaped: {error}"
            )
        })?;
        return Ok(false);
    }
    fs::create_dir_all(&paths.fastctx_dir).map_err(|error| {
        format!(
            "Cannot create fastctx settings directory {}: {error}",
            crate::paths::display_path(&paths.fastctx_dir)
        )
    })?;
    transaction::atomic_replace(&paths.fastctx_config, &bytes, None)?;
    crate::shell::jobs::reap(paths).map_err(|error| {
        format!("Settings were saved, but finished job records could not be reaped: {error}")
    })?;
    Ok(true)
}

#[cfg(test)]
mod tests {
    use super::{Tier, load_from};
    use crate::control::paths::ControlPaths;

    #[test]
    fn future_or_missing_schema_versions_are_read_only_failures() {
        let temp = tempfile::tempdir().unwrap();
        let future = temp.path().join("future.toml");
        std::fs::write(&future, b"schema_version = 999\n").unwrap();
        let error = load_from(&future).unwrap_err();
        assert!(error.contains("written by a newer fastctx"), "{error}");
        assert_eq!(std::fs::read(&future).unwrap(), b"schema_version = 999\n");

        let missing = temp.path().join("missing-version.toml");
        std::fs::write(&missing, b"tier = \"high\"\n").unwrap();
        let error = load_from(&missing).unwrap_err();
        assert!(error.contains("schema_version is missing"), "{error}");
        assert_eq!(std::fs::read(&missing).unwrap(), b"tier = \"high\"\n");
    }

    #[test]
    fn stored_tool_budgets_are_loaded_and_resolved_against_the_tier() {
        let temp = tempfile::tempdir().unwrap();
        let config = temp.path().join("config.toml");
        std::fs::write(
            &config,
            concat!(
                "schema_version = 1\n",
                "tier = \"high\"\n",
                "\n[tool_budgets]\n",
                "read = \"percent25\"\n",
                "grep = \"percent75\"\n",
                "glob = \"inherit\"\n",
                "run = \"percent75\"\n",
                "job_output = \"inherit\"\n",
            ),
        )
        .unwrap();

        let settings = load_from(&config).unwrap();
        assert_eq!(settings.tier, Tier::High);
        let resolved = settings.tool_budgets.resolve(settings.tier);
        assert_eq!(
            resolved.read,
            super::ToolBudgetLevel::Percent(25),
            "an explicit share must survive the tier"
        );
        assert_eq!(
            resolved.glob,
            super::ToolBudgetLevel::Inherit,
            "an inherit entry stays inherited"
        );
        assert_eq!(
            resolved.run,
            super::ToolBudgetLevel::Percent(75),
            "an explicit share must survive the tier"
        );
    }

    #[test]
    fn a_missing_config_file_loads_the_defaults() {
        let temp = tempfile::tempdir().unwrap();
        let paths = ControlPaths::for_home(temp.path());
        let settings = super::load(&paths).unwrap();
        assert_eq!(settings, super::FastCtxSettings::default());
    }
}
