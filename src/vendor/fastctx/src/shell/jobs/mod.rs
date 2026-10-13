// Modified by dsh-ops (https://github.com/T-Auto/dsh-ops): removed the TUI job-tail reader, the Apply/Unapply admission and kill helpers, and the permission-denied classification only the TUI read.
//! Persistent background jobs whose supervisors and records outlive every MCP server session.

pub(crate) mod admission;
mod background;
mod host;
mod identity;
mod model;
mod output_log;
mod store;

use crate::budget::{
    GLOBAL_TOKEN_BUDGET_ENV, JOB_OUTPUT_TOKEN_BUDGET_ENV, TokenBudget, estimate_tokens,
    relax_tool_token_budget, tool_token_budget_for_required,
};
use crate::control::paths::ControlPaths;
use crate::model::ToolResponse;
use crate::paths::display_path;
use crate::shell::JobListStatus;
use crate::shell::encoding::{
    OutputEncoding, decode_job, job_garble_note, validate_output_encoding,
};
use crate::shell::output::{
    budget_too_small_message, compose_response_with_tail, global_token_budget,
    job_output_token_budget, plural, terminal_response,
};
use model::{JobRecord, JobStatus, LaunchSpec, StoredLine};
use std::collections::HashMap;
use std::fmt::{Display, Formatter};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime};

const KILL_ACK_TIMEOUT: Duration = Duration::from_secs(6);
const REGISTRY_POLL: Duration = Duration::from_millis(20);

#[derive(Clone, Debug)]
pub(crate) struct JobManager {
    paths: Result<ControlPaths, String>,
    executable: Result<PathBuf, String>,
    admission_generation: Result<u64, String>,
    cursors: Arc<Mutex<HashMap<String, u64>>>,
    background: background::BackgroundTracker,
}

pub(crate) struct BackgroundLaunch<'a> {
    pub(crate) bash: &'a Path,
    pub(crate) command: &'a str,
    pub(crate) cwd: &'a Path,
    pub(crate) login_shell: bool,
    pub(crate) encoding: Option<OutputEncoding>,
    pub(crate) environment: &'a crate::session::SessionEnvironment,
    pub(crate) utf8_locale: &'a str,
}

#[derive(Clone, Debug)]
struct OutputSnapshot {
    status: JobStatus,
    head: Vec<StoredLine>,
    tail: Vec<StoredLine>,
    unread_first: u64,
    unread_last: u64,
    all_unread_loaded: bool,
    total_lines: u64,
    legacy_loss: bool,
    capture_error: Option<model::CaptureErrorRecord>,
    output_truncation: Option<model::OutputTruncationRecord>,
    default_encoding: Option<OutputEncoding>,
    anchor: u64,
    direct_log: Option<PathBuf>,
}

#[derive(Clone, Debug)]
struct FormattedPage {
    response: String,
    cursor_seq: Option<u64>,
}

/// Stable control-plane view of one persistent job record.
#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct JobSummary {
    pub(crate) id: String,
    pub(crate) command: String,
    pub(crate) cwd: String,
    pub(crate) started_at: String,
    pub(crate) status: JobSummaryStatus,
    pub(crate) source: JobSourceSummary,
}

/// Stable best-effort source identity for grouping jobs from distinct server sessions.
#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct JobSourceSummary {
    pub(crate) key: String,
    pub(crate) tag: String,
    pub(crate) server_pid: u32,
    pub(crate) parent_executable: Option<String>,
    pub(crate) server_cwd: String,
}

/// Public three-state lifecycle used by CLI and TUI without exposing storage internals.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum JobSummaryStatus {
    Running,
    Exited(i32),
    Interrupted,
}

/// Diagnosable registry failure.
#[derive(Debug)]
pub(crate) struct JobRegistryError {
    message: String,
}

impl JobRegistryError {
    pub(super) fn from_io(context: String, error: std::io::Error) -> Self {
        Self {
            message: format!("{context}: {error}"),
        }
    }

    pub(super) fn data(message: String) -> Self {
        Self { message }
    }
}

impl Display for JobRegistryError {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(&self.message)
    }
}

impl std::error::Error for JobRegistryError {}

impl From<JobRegistryError> for String {
    fn from(error: JobRegistryError) -> Self {
        error.message
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum KillState {
    Killed,
    AlreadyExited(i32),
    AlreadyInterrupted,
}

impl JobManager {
    pub(crate) fn new() -> Self {
        Self::with_session(crate::session::SessionContext::library_default())
    }

    pub(crate) fn with_session(session: Arc<crate::session::SessionContext>) -> Self {
        let paths = Ok(session.control_paths.clone());
        let admission_generation = paths
            .as_ref()
            .map_err(Clone::clone)
            .and_then(admission::observe_generation);
        Self {
            paths,
            executable: std::env::current_exe()
                .map_err(|error| format!("Cannot locate the running fastctx binary: {error}")),
            admission_generation,
            cursors: Arc::new(Mutex::new(HashMap::new())),
            background: background::BackgroundTracker::default(),
        }
    }

    pub(crate) fn start(&self, launch: BackgroundLaunch<'_>) -> ToolResponse {
        let BackgroundLaunch {
            bash,
            command,
            cwd,
            login_shell,
            encoding,
            environment,
            utf8_locale,
        } = launch;
        let paths = match self.paths() {
            Ok(paths) => paths,
            Err(error) => return ToolResponse::error(error),
        };
        let executable = match self.executable.as_ref() {
            Ok(executable) => executable,
            Err(error) => return ToolResponse::error(error.clone()),
        };
        let admission_generation = match self.admission_generation.as_ref() {
            Ok(generation) => *generation,
            Err(error) => return ToolResponse::error(error.clone()),
        };
        let _admission = match admission::AdmissionGuard::acquire(paths) {
            Ok(guard) if guard.generation() == admission_generation => guard,
            Ok(_) => {
                return ToolResponse::error(
                    "This FastCtx server predates the current configuration. Start a new session and retry run_background."
                        .to_string(),
                );
            }
            Err(error) => return ToolResponse::error(error),
        };
        let limits = match store::effective_limits(paths) {
            Ok(limits) => limits,
            Err(error) => return ToolResponse::error(error),
        };
        if let Err(error) = store::reap(paths, limits.storage_limit_mib) {
            return ToolResponse::error(error);
        }
        let (job_id, job_dir) = match store::reserve_job(&paths.jobs_dir) {
            Ok(reservation) => reservation,
            Err(error) => return ToolResponse::error(error),
        };
        let registry = match store::scan_registry(&paths.jobs_dir) {
            Ok(registry) => registry,
            Err(error) => {
                store::remove_reserved_job(&job_dir);
                return ToolResponse::error(error);
            }
        };
        let active = registry
            .records
            .iter()
            .filter(|record| record.status.is_running())
            .count() as u64
            + registry.pending_reservations;
        if active > limits.max_running_jobs {
            store::remove_reserved_job(&job_dir);
            return ToolResponse::error(format!(
                "Too many running jobs: the limit is {} across all FastCtx sessions for the current user. Kill or wait out an existing job first.",
                limits.max_running_jobs
            ));
        }

        let log_path = job_dir.join(model::OUTPUT_LOG_FILE);
        let terminal = format!(
            "(Complete: job {job_id} started; log at {}.)",
            display_path(&log_path)
        );
        let budget = match tool_token_budget_for_required(
            GLOBAL_TOKEN_BUDGET_ENV,
            estimate_tokens(&terminal),
        ) {
            Ok(budget) => budget,
            Err(error) => {
                store::remove_reserved_job(&job_dir);
                return ToolResponse::error(error);
            }
        };
        if estimate_tokens(&terminal) > budget.value {
            store::remove_reserved_job(&job_dir);
            return ToolResponse::error(budget_too_small_message(budget));
        }
        let spec = LaunchSpec {
            job_id: job_id.clone(),
            job_dir: job_dir.clone(),
            bash: bash.to_path_buf(),
            command: command.to_string(),
            cwd: cwd.to_path_buf(),
            login_shell,
            encoding: encoding.map(|encoding| encoding.label().to_string()),
            environment: environment.clone(),
            utf8_locale: utf8_locale.to_string(),
            output_limit_bytes: limits.storage_limit_mib.saturating_mul(1024 * 1024),
            origin: store::origin_snapshot(environment.cwd()),
        };
        match host::launch_supervisor(executable, &spec) {
            Ok(()) => {
                self.background.track_id(&job_id, SystemTime::now());
                ToolResponse::text(terminal)
            }
            Err(error) => {
                let live = store::read_json::<model::JobMeta>(
                    &job_dir.join(model::META_FILE),
                    "job metadata",
                )
                .ok()
                .flatten()
                .is_some_and(|meta| identity::identity_is_alive(&meta.supervisor));
                if !live {
                    store::remove_reserved_job(&job_dir);
                }
                ToolResponse::error(error)
            }
        }
    }

    pub(crate) fn output_until_cancelled(
        &self,
        job_id: &str,
        wait_ms: u64,
        after_seq: Option<u64>,
        encoding: Option<OutputEncoding>,
        cancelled: impl Fn() -> bool,
    ) -> ToolResponse {
        let paths = match self.paths() {
            Ok(paths) => paths,
            Err(error) => return ToolResponse::error(error),
        };
        let mut budget = match job_output_token_budget() {
            Ok(budget) => budget,
            Err(error) => return ToolResponse::error(error),
        };
        let started = Instant::now();
        let wait = Duration::from_millis(wait_ms);
        let anchor = after_seq.unwrap_or_else(|| {
            self.cursors
                .lock()
                .unwrap()
                .get(job_id)
                .copied()
                .unwrap_or(0)
        });
        let record = loop {
            if cancelled() {
                return ToolResponse::error(
                    "The job output wait was cancelled because the MCP request or server session ended."
                        .to_string(),
                );
            }
            let record = match store::find_record(&paths.jobs_dir, job_id) {
                Ok(Some(record)) => {
                    self.background.track_record(&record, SystemTime::now());
                    record
                }
                Ok(None) => {
                    self.background.remove(job_id);
                    return missing_job(job_id);
                }
                Err(error) => return ToolResponse::error(error),
            };
            let capture_failed = match store::capture_error(&record) {
                Ok(capture_error) => capture_error.is_some(),
                Err(error) => return ToolResponse::error(error),
            };
            let output_truncated = match store::output_truncation(&record) {
                Ok(truncation) => truncation.is_some(),
                Err(error) => return ToolResponse::error(error),
            };
            if !record.status.is_running()
                || capture_failed
                || output_truncated
                || started.elapsed() >= wait
            {
                break record;
            }
            let remaining = wait.saturating_sub(started.elapsed());
            std::thread::sleep(remaining.min(REGISTRY_POLL));
        };
        let default_encoding = match record
            .meta
            .encoding
            .as_deref()
            .map(validate_output_encoding)
            .transpose()
        {
            Ok(encoding) => encoding,
            Err(error) => {
                return ToolResponse::error(format!(
                    "Cannot read job {job_id}: its stored output encoding is invalid ({error})"
                ));
            }
        };
        let page = loop {
            let snapshot = match load_output_snapshot(&record, anchor, default_encoding, budget) {
                Ok(snapshot) => snapshot,
                Err(error) => {
                    if error.to_ascii_lowercase().contains("too small to return") {
                        match relax_tool_token_budget(JOB_OUTPUT_TOKEN_BUDGET_ENV) {
                            Ok(Some(expanded)) => {
                                budget = expanded;
                                continue;
                            }
                            Ok(None) => {}
                            Err(config_error) => return ToolResponse::error(config_error),
                        }
                    }
                    return ToolResponse::error(error);
                }
            };
            match format_snapshot(job_id, wait_ms, &snapshot, encoding, budget) {
                Ok(page) => break page,
                Err(error) => {
                    if error.to_ascii_lowercase().contains("too small to return") {
                        match relax_tool_token_budget(JOB_OUTPUT_TOKEN_BUDGET_ENV) {
                            Ok(Some(expanded)) => {
                                budget = expanded;
                                continue;
                            }
                            Ok(None) => {}
                            Err(config_error) => return ToolResponse::error(config_error),
                        }
                    }
                    return ToolResponse::error(error);
                }
            }
        };
        if let Some(cursor_seq) = page.cursor_seq {
            let mut cursors = self.cursors.lock().unwrap();
            let cursor = cursors.entry(job_id.to_string()).or_insert(0);
            *cursor = (*cursor).max(cursor_seq);
        }
        if !record.status.is_running() {
            self.background.remove(job_id);
        }
        ToolResponse::text(page.response)
    }

    pub(crate) fn kill(&self, job_id: &str) -> ToolResponse {
        let paths = match self.paths() {
            Ok(paths) => paths,
            Err(error) => return ToolResponse::error(error),
        };
        let killed = format!("(Complete: job {job_id} killed.)");
        let required = [
            estimate_tokens(&killed),
            estimate_tokens(&format!(
                "(Complete: job {job_id} had already exited with code {}.)",
                i32::MIN
            )),
            estimate_tokens(&format!(
                "(Complete: job {job_id} had already been interrupted.)"
            )),
        ]
        .into_iter()
        .max()
        .unwrap_or(0);
        let budget = match tool_token_budget_for_required(GLOBAL_TOKEN_BUDGET_ENV, required) {
            Ok(budget) => budget,
            Err(error) => return ToolResponse::error(error),
        };
        if estimate_tokens(&killed) > budget.value {
            return ToolResponse::error(budget_too_small_message(budget));
        }
        let response = match terminate(paths, job_id) {
            Ok(KillState::Killed) => ToolResponse::text(killed),
            Ok(KillState::AlreadyExited(code)) => global_terminal(format!(
                "(Complete: job {job_id} had already exited with code {code}.)"
            )),
            Ok(KillState::AlreadyInterrupted) => global_terminal(format!(
                "(Complete: job {job_id} had already been interrupted.)"
            )),
            Err(error) => {
                if matches!(store::find_record(&paths.jobs_dir, job_id), Ok(None)) {
                    self.background.remove(job_id);
                }
                return ToolResponse::error(error);
            }
        };
        if !response.is_error {
            self.background.remove(job_id);
        }
        response
    }

    pub(crate) fn list(
        &self,
        status: JobListStatus,
        offset: u64,
        limit: Option<u64>,
    ) -> ToolResponse {
        let paths = match self.paths() {
            Ok(paths) => paths,
            Err(error) => return ToolResponse::error(error),
        };
        let registry = match store::scan_registry(&paths.jobs_dir) {
            Ok(registry) => registry,
            Err(error) => return ToolResponse::error(error),
        };
        let limit = match limit {
            Some(limit) => limit,
            None => match crate::control::settings::load(paths) {
                Ok(settings) => settings.fastshell.job_list_limit,
                Err(error) => return ToolResponse::error(error),
            },
        };
        format_job_list(registry.records, status, offset, limit)
    }

    fn paths(&self) -> Result<&ControlPaths, String> {
        self.paths.as_ref().map_err(Clone::clone)
    }

    pub(crate) fn background_status_at(
        &self,
        exclude: Option<&str>,
        now: SystemTime,
    ) -> Option<crate::background_status::BackgroundStatus> {
        if !self.background.has_candidates(exclude) {
            return None;
        }
        let paths = self.paths().ok()?;
        self.background.snapshot(paths, exclude, now)
    }
}

fn terminate(paths: &ControlPaths, job_id: &str) -> Result<KillState, String> {
    let record =
        store::find_record(&paths.jobs_dir, job_id)?.ok_or_else(|| missing_job_text(job_id))?;
    match &record.status {
        JobStatus::Exited(exit) => return Ok(KillState::AlreadyExited(exit.exit_code)),
        JobStatus::Interrupted => return Ok(KillState::AlreadyInterrupted),
        JobStatus::Running => {}
    }
    store::request_kill(&record)?;
    let deadline = Instant::now() + KILL_ACK_TIMEOUT;
    loop {
        let record =
            store::find_record(&paths.jobs_dir, job_id)?.ok_or_else(|| missing_job_text(job_id))?;
        match record.status {
            JobStatus::Running if Instant::now() < deadline => {}
            JobStatus::Running => {
                return Err(format!(
                    "Cannot kill job {job_id}: its supervisor did not acknowledge within 6 seconds. Retry job_kill or stop the supervisor process manually."
                ));
            }
            JobStatus::Exited(exit) if exit.was_killed() => {
                return Ok(KillState::Killed);
            }
            JobStatus::Exited(exit) => return Ok(KillState::AlreadyExited(exit.exit_code)),
            JobStatus::Interrupted => return Ok(KillState::AlreadyInterrupted),
        }
        std::thread::sleep(REGISTRY_POLL);
    }
}

impl Default for JobManager {
    fn default() -> Self {
        Self::new()
    }
}

fn format_snapshot(
    job_id: &str,
    wait_ms: u64,
    snapshot: &OutputSnapshot,
    call_encoding: Option<OutputEncoding>,
    budget: TokenBudget,
) -> Result<FormattedPage, String> {
    if snapshot.head.is_empty() && snapshot.tail.is_empty() {
        let candidate = render_candidate(job_id, wait_ms, snapshot, call_encoding, 0, 0);
        if estimate_tokens(&candidate.response) > budget.value {
            return Err(budget_too_small_message(budget));
        }
        return Ok(FormattedPage {
            response: candidate.response,
            cursor_seq: (snapshot.unread_last > snapshot.anchor).then_some(snapshot.unread_last),
        });
    }

    if snapshot.all_unread_loaded {
        let candidate = render_candidate(
            job_id,
            wait_ms,
            snapshot,
            call_encoding,
            snapshot.head.len(),
            0,
        );
        if estimate_tokens(&candidate.response) <= budget.value {
            return Ok(FormattedPage {
                response: candidate.response,
                cursor_seq: snapshot
                    .direct_log
                    .as_ref()
                    .map(|_| snapshot.unread_last)
                    .or(candidate.last_seq),
            });
        }
    }

    if snapshot.direct_log.is_none() {
        return format_legacy_page(job_id, wait_ms, snapshot, call_encoding, budget);
    }

    format_direct_window(job_id, wait_ms, snapshot, call_encoding, budget)
}

#[derive(Debug)]
struct RenderedCandidate {
    response: String,
    last_seq: Option<u64>,
}

fn load_output_snapshot(
    record: &JobRecord,
    anchor: u64,
    default_encoding: Option<OutputEncoding>,
    budget: TokenBudget,
) -> Result<OutputSnapshot, String> {
    let mut log = store::open_log(record)?;
    let direct_log = log.direct_path().map(Path::to_path_buf);
    let total_lines = log.total_lines();
    let requested_first = anchor.saturating_add(1);
    let unread_first = requested_first.max(log.oldest_seq());
    let max_lines = budget.value.saturating_mul(4).saturating_add(64);
    let max_bytes = budget.value.saturating_mul(16).saturating_add(64 * 1024);
    let mut head = Vec::new();
    let mut tail = Vec::new();
    let mut all_unread_loaded = true;
    if unread_first <= total_lines {
        let prefix = log.read_prefix_bounded(unread_first, total_lines, max_lines, max_bytes)?;
        all_unread_loaded = prefix.complete;
        head = prefix.lines;
        if !all_unread_loaded && direct_log.is_some() {
            if anchor != 0 {
                head.clear();
            }
            let suffix =
                log.read_suffix_bounded(unread_first, total_lines, max_lines, max_bytes)?;
            tail = suffix.lines;
            if let Some(last_head) = head.last().map(|line| line.seq) {
                tail.retain(|line| line.seq > last_head);
            }
        }
    }
    let legacy_loss = log.had_irretrievable_loss() || unread_first > requested_first;
    Ok(OutputSnapshot {
        status: record.status.clone(),
        head,
        tail,
        unread_first,
        unread_last: total_lines,
        all_unread_loaded,
        total_lines,
        legacy_loss,
        capture_error: log.capture_error.clone(),
        output_truncation: log.output_truncation.clone(),
        default_encoding,
        anchor,
        direct_log,
    })
}

fn format_legacy_page(
    job_id: &str,
    wait_ms: u64,
    snapshot: &OutputSnapshot,
    call_encoding: Option<OutputEncoding>,
    budget: TokenBudget,
) -> Result<FormattedPage, String> {
    let mut low = 1_usize;
    let mut high = snapshot.head.len();
    let mut best = None;
    while low <= high {
        let shown = low + (high - low) / 2;
        let candidate = render_candidate(job_id, wait_ms, snapshot, call_encoding, shown, 0);
        if estimate_tokens(&candidate.response) <= budget.value {
            best = Some(candidate);
            low = shown.saturating_add(1);
        } else if shown == 1 {
            break;
        } else {
            high = shown - 1;
        }
    }
    let candidate = best.ok_or_else(|| budget_too_small_message(budget))?;
    Ok(FormattedPage {
        response: candidate.response,
        cursor_seq: candidate.last_seq,
    })
}

fn format_direct_window(
    job_id: &str,
    wait_ms: u64,
    snapshot: &OutputSnapshot,
    call_encoding: Option<OutputEncoding>,
    budget: TokenBudget,
) -> Result<FormattedPage, String> {
    let tail_available = if snapshot.all_unread_loaded {
        snapshot.head.len()
    } else {
        snapshot.tail.len()
    };
    if tail_available == 0 {
        return Err(budget_too_small_message(budget));
    }
    let head_available = if snapshot.anchor == 0 {
        if snapshot.all_unread_loaded {
            snapshot.head.len().saturating_sub(1)
        } else {
            snapshot.head.len()
        }
    } else {
        0
    };
    let preferred_head = preferred_head_count(
        snapshot,
        call_encoding,
        head_available,
        budget.value.saturating_div(10).max(1),
    );
    let mut low = 0_usize;
    let mut high = preferred_head;
    let mut head_that_fits = None;
    while low <= high {
        let head = low + (high - low) / 2;
        let candidate = render_candidate(job_id, wait_ms, snapshot, call_encoding, head, 1);
        if estimate_tokens(&candidate.response) <= budget.value {
            head_that_fits = Some(head);
            low = head.saturating_add(1);
        } else if head == 0 {
            break;
        } else {
            high = head - 1;
        }
    }
    let head = head_that_fits.ok_or_else(|| budget_too_small_message(budget))?;
    let tail_limit = if snapshot.all_unread_loaded {
        tail_available.saturating_sub(head)
    } else {
        tail_available
    };
    let mut low = 1_usize;
    let mut high = tail_limit;
    let mut best = None;
    while low <= high {
        let tail = low + (high - low) / 2;
        let candidate = render_candidate(job_id, wait_ms, snapshot, call_encoding, head, tail);
        if estimate_tokens(&candidate.response) <= budget.value {
            best = Some(candidate);
            low = tail.saturating_add(1);
        } else if tail == 1 {
            break;
        } else {
            high = tail - 1;
        }
    }
    let candidate = best.ok_or_else(|| budget_too_small_message(budget))?;
    Ok(FormattedPage {
        response: candidate.response,
        cursor_seq: Some(snapshot.unread_last),
    })
}

fn preferred_head_count(
    snapshot: &OutputSnapshot,
    call_encoding: Option<OutputEncoding>,
    available: usize,
    token_target: usize,
) -> usize {
    let mut low = 0_usize;
    let mut high = available;
    let mut best = 0_usize;
    while low <= high {
        let count = low + (high - low) / 2;
        let selected = select_lines(snapshot, count, 0);
        let encoded = selected
            .iter()
            .map(|line| line.encoded_line())
            .collect::<Vec<_>>();
        let decoded = decode_job(&encoded, call_encoding, snapshot.default_encoding);
        if estimate_tokens(&decoded.lines.join("\n")) <= token_target {
            best = count;
            low = count.saturating_add(1);
        } else if count == 0 {
            break;
        } else {
            high = count - 1;
        }
    }
    best
}

fn render_candidate(
    job_id: &str,
    wait_ms: u64,
    snapshot: &OutputSnapshot,
    call_encoding: Option<OutputEncoding>,
    head_count: usize,
    tail_count: usize,
) -> RenderedCandidate {
    let selected = select_lines(snapshot, head_count, tail_count);
    let encoded = selected
        .iter()
        .map(|line| line.encoded_line())
        .collect::<Vec<_>>();
    let decoded = decode_job(&encoded, call_encoding, snapshot.default_encoding);
    let mut notes = Vec::new();
    if let Some(path) = snapshot.direct_log.as_ref() {
        for (first, last) in omitted_ranges(snapshot, &selected) {
            notes.push(omission_note(first, last, path));
        }
    } else if snapshot.legacy_loss {
        notes.push(legacy_loss_note(snapshot));
    }
    if let Some(error) = &snapshot.capture_error {
        notes.push(capture_failure_note(error, snapshot.direct_log.as_deref()));
    }
    if let Some(truncation) = &snapshot.output_truncation {
        notes.push(output_truncation_note(
            truncation,
            snapshot.direct_log.as_deref(),
        ));
    }
    if let Some(note) = job_garble_note(decoded.invalid_sequences, snapshot.anchor) {
        notes.push(note);
    }
    if let Some(path) = snapshot.direct_log.as_ref() {
        for (line, truncated) in selected.iter().zip(&decoded.truncated_per_line) {
            if *truncated {
                notes.push(format!(
                    "(Note: line {} was truncated at 2000 chars in this response; read the complete line at {} with offset={}, or inspect a fragment with grep or the inspect_local_file tool's hex view.)",
                    line.seq,
                    display_path(path),
                    line.seq
                ));
            }
        }
    }
    let leading = (!notes.is_empty()).then(|| notes.join("\n\n"));
    let last_seq = selected.last().map(|line| line.seq);
    let terminal = output_terminal(job_id, wait_ms, snapshot, selected.len(), last_seq);
    RenderedCandidate {
        response: compose_response_with_tail(
            leading.as_deref(),
            &decoded.lines,
            decoded.transcoding_note.as_deref(),
            &terminal,
        ),
        last_seq,
    }
}

fn select_lines(
    snapshot: &OutputSnapshot,
    head_count: usize,
    tail_count: usize,
) -> Vec<&StoredLine> {
    let mut selected = Vec::new();
    if snapshot.all_unread_loaded {
        let head = head_count.min(snapshot.head.len());
        selected.extend(snapshot.head.iter().take(head));
        let tail = tail_count.min(snapshot.head.len().saturating_sub(head));
        if tail > 0 {
            selected.extend(snapshot.head[snapshot.head.len() - tail..].iter());
        }
        return selected;
    }
    selected.extend(snapshot.head.iter().take(head_count));
    let tail = tail_count.min(snapshot.tail.len());
    if tail > 0 {
        let last_head = selected.last().map(|line| line.seq).unwrap_or(0);
        selected.extend(
            snapshot.tail[snapshot.tail.len() - tail..]
                .iter()
                .filter(|line| line.seq > last_head),
        );
    }
    selected
}

fn omitted_ranges(snapshot: &OutputSnapshot, selected: &[&StoredLine]) -> Vec<(u64, u64)> {
    if snapshot.unread_first > snapshot.unread_last {
        return Vec::new();
    }
    let mut ranges = Vec::new();
    let mut next = snapshot.unread_first;
    for line in selected {
        if line.seq > next {
            ranges.push((next, line.seq - 1));
        }
        next = line.seq.saturating_add(1);
    }
    if next <= snapshot.unread_last {
        ranges.push((next, snapshot.unread_last));
    }
    ranges
}

fn omission_note(first: u64, last: u64, path: &Path) -> String {
    if first == last {
        format!(
            "(Note: line {first} was omitted from this response; read it at {} with offset={first}.)",
            display_path(path)
        )
    } else {
        format!(
            "(Note: lines {first}-{last} were omitted from this response; read them at {} with offset={first}.)",
            display_path(path)
        )
    }
}

fn legacy_loss_note(snapshot: &OutputSnapshot) -> String {
    let expected = snapshot.anchor.saturating_add(1);
    let missing = snapshot.unread_first.saturating_sub(expected);
    if missing > 0 {
        format!(
            "(Note: {missing} earlier {} {} dropped from this legacy job record and cannot be retrieved.)",
            plural(missing, "line", "lines"),
            if missing == 1 { "was" } else { "were" }
        )
    } else {
        "(Note: this legacy job record lost or truncated output that cannot be retrieved.)"
            .to_string()
    }
}

fn capture_failure_note(error: &model::CaptureErrorRecord, direct_log: Option<&Path>) -> String {
    match direct_log {
        Some(path) => format!(
            "(Note: output capture failed after seq {}: {}. This does not kill the process; its exit status remains available, but the log at {} stops here.)",
            error.after_seq,
            error.reason,
            display_path(path)
        ),
        None => format!(
            "(Note: output capture failed after seq {}: {}. This did not kill the process; its exit status remains available, but this legacy record stops here.)",
            error.after_seq, error.reason
        ),
    }
}

fn output_truncation_note(
    truncation: &model::OutputTruncationRecord,
    direct_log: Option<&Path>,
) -> String {
    match direct_log {
        Some(path) => format!(
            "(Note: this job reached its {}-byte combined output.log + output.idx hard limit after seq {}. The supervisor kept draining output and did not stop the command, but later output was not persisted. The preserved prefix is at {}.)",
            truncation.limit_bytes,
            truncation.after_seq,
            display_path(path)
        ),
        None => format!(
            "(Note: this job reached its {}-byte output hard limit after seq {}. The supervisor kept draining output and did not stop the command, but later output was not persisted.)",
            truncation.limit_bytes, truncation.after_seq
        ),
    }
}

fn output_terminal(
    job_id: &str,
    wait_ms: u64,
    snapshot: &OutputSnapshot,
    shown: usize,
    last_seq: Option<u64>,
) -> String {
    if let JobStatus::Running = snapshot.status {
        if shown > 0 {
            return format!(
                "(Partial: job {job_id} is running; {shown} new {} shown. Call job_output again for more, or move on and check back.)",
                plural(shown as u64, "line", "lines")
            );
        }
        if wait_ms < crate::shell::MAX_BLOCKING_CALL_MS {
            return format!(
                "(Partial: job {job_id} is running; no new output within {wait_ms} ms. Move on and check back, or raise wait_ms if you have nothing else to do.)"
            );
        }
        return format!(
            "(Partial: job {job_id} is running; no new output within {wait_ms} ms. It may stay quiet for a long time, or never exit — move on and check back.)"
        );
    }
    if let Some(path) = snapshot.direct_log.as_ref() {
        return match &snapshot.status {
            JobStatus::Exited(exit) if exit.was_killed() => format!(
                "(Complete: job {job_id} was killed; {} {} total. Full log: {})",
                snapshot.total_lines,
                plural(snapshot.total_lines, "line", "lines"),
                display_path(path)
            ),
            JobStatus::Exited(exit) => format!(
                "(Complete: job {job_id} exited {}; {} {} total. Full log: {})",
                exit.exit_code,
                snapshot.total_lines,
                plural(snapshot.total_lines, "line", "lines"),
                display_path(path)
            ),
            JobStatus::Interrupted => format!(
                "(Complete: job {job_id} was interrupted: its process ended without an exit record (machine restart or external kill); {} {} preserved. Full log: {})",
                snapshot.total_lines,
                plural(snapshot.total_lines, "line", "lines"),
                display_path(path)
            ),
            JobStatus::Running => unreachable!(),
        };
    }
    let next = last_seq.unwrap_or(snapshot.anchor);
    let more = next < snapshot.unread_last
        && (!snapshot.all_unread_loaded
            || snapshot.head.last().is_some_and(|line| line.seq > next));
    if more {
        return match &snapshot.status {
            JobStatus::Exited(exit) if exit.was_killed() => format!(
                "(Partial: job {job_id} was killed; more legacy output remains. Call job_output again with after_seq={next}.)"
            ),
            JobStatus::Exited(exit) => format!(
                "(Partial: job {job_id} exited {}; more legacy output remains. Call job_output again with after_seq={next}.)",
                exit.exit_code
            ),
            JobStatus::Interrupted => format!(
                "(Partial: job {job_id} was interrupted; more legacy output remains. Call job_output again with after_seq={next}.)"
            ),
            JobStatus::Running => unreachable!(),
        };
    }
    let loss = if snapshot.legacy_loss {
        ", but this legacy record lost or truncated output that cannot be retrieved"
    } else {
        ""
    };
    match &snapshot.status {
        JobStatus::Exited(exit) if exit.was_killed() => format!(
            "(Complete: job {job_id} was killed; {} {} total{loss}.)",
            snapshot.total_lines,
            plural(snapshot.total_lines, "line", "lines")
        ),
        JobStatus::Exited(exit) => format!(
            "(Complete: job {job_id} exited {}; {} {} total{loss}.)",
            exit.exit_code,
            snapshot.total_lines,
            plural(snapshot.total_lines, "line", "lines")
        ),
        JobStatus::Interrupted => format!(
            "(Complete: job {job_id} was interrupted: its process ended without an exit record (machine restart or external kill); {} {} preserved{loss}.)",
            snapshot.total_lines,
            plural(snapshot.total_lines, "line", "lines")
        ),
        JobStatus::Running => unreachable!(),
    }
}

fn format_job_list(
    records: Vec<JobRecord>,
    status: JobListStatus,
    offset: u64,
    limit: u64,
) -> ToolResponse {
    let mut budget = match global_token_budget() {
        Ok(budget) => budget,
        Err(error) => return ToolResponse::error(error),
    };
    loop {
        let response = format_job_list_with_budget(records.clone(), status, offset, limit, budget);
        let starved = response.is_error
            && response.content.iter().any(|content| {
                matches!(content, crate::ToolContent::Text(text) if text.to_ascii_lowercase().contains("too small to return"))
            });
        if starved {
            match relax_tool_token_budget(GLOBAL_TOKEN_BUDGET_ENV) {
                Ok(Some(expanded)) => {
                    budget = expanded;
                    continue;
                }
                Ok(None) => {}
                Err(error) => return ToolResponse::error(error),
            }
        }
        return response;
    }
}

fn format_job_list_with_budget(
    mut records: Vec<JobRecord>,
    status: JobListStatus,
    offset: u64,
    limit: u64,
    budget: TokenBudget,
) -> ToolResponse {
    records.retain(|record| match status {
        JobListStatus::Running => record.status.is_running(),
        JobListStatus::Finished => !record.status.is_running(),
        JobListStatus::All => true,
    });
    if records.is_empty() {
        return terminal_response(empty_job_list_terminal(status), budget);
    }
    records.sort_by(
        |left, right| match (left.status.is_running(), right.status.is_running()) {
            (true, false) => std::cmp::Ordering::Less,
            (false, true) => std::cmp::Ordering::Greater,
            (true, true) => store::started_sort_key(right).cmp(&store::started_sort_key(left)),
            (false, false) => right
                .ended_sort_key
                .cmp(&left.ended_sort_key)
                .then_with(|| right.id.cmp(&left.id)),
        },
    );
    let running = records
        .iter()
        .filter(|record| record.status.is_running())
        .count() as u64;
    let finished = records.len() as u64 - running;
    let total = records.len();
    let start = usize::try_from(offset).unwrap_or(usize::MAX).min(total);
    if start == total {
        return terminal_response(
            format!(
                "(Complete: no {} at offset={offset}; {total} available.)",
                job_list_scope(status)
            ),
            budget,
        );
    }
    let page_end = start
        .saturating_add(usize::try_from(limit).unwrap_or(usize::MAX))
        .min(total);
    let entries = records[start..page_end]
        .iter()
        .map(format_job_entry)
        .collect::<Vec<_>>();
    let complete_terminal = complete_job_list_terminal(status, running, finished);
    let terminal = if page_end < total {
        partial_job_list_terminal(status, start, entries.len(), total, limit)
    } else {
        complete_terminal.clone()
    };
    let complete = compose_list(&entries, &terminal);
    if estimate_tokens(&complete) <= budget.value {
        return ToolResponse::text(complete);
    }
    let mut low = 1_usize;
    let mut high = entries.len();
    let mut best = None;
    while low <= high {
        let shown = low + (high - low) / 2;
        let terminal = partial_job_list_terminal(status, start, shown, total, limit);
        let response = compose_list(&entries[..shown], &terminal);
        if estimate_tokens(&response) <= budget.value {
            best = Some(response);
            low = shown.saturating_add(1);
        } else if shown == 1 {
            break;
        } else {
            high = shown - 1;
        }
    }
    best.map_or_else(
        || ToolResponse::error(budget_too_small_message(budget)),
        ToolResponse::text,
    )
}

fn empty_job_list_terminal(status: JobListStatus) -> String {
    match status {
        JobListStatus::Running => "(Complete: no running jobs.)",
        JobListStatus::Finished => "(Complete: no finished records.)",
        JobListStatus::All => "(Complete: no jobs.)",
    }
    .to_string()
}

fn complete_job_list_terminal(status: JobListStatus, running: u64, finished: u64) -> String {
    match status {
        JobListStatus::Running => format!(
            "(Complete: {running} running {}.)",
            plural(running, "job", "jobs")
        ),
        JobListStatus::Finished => format!(
            "(Complete: {finished} finished {}.)",
            plural(finished, "record", "records")
        ),
        JobListStatus::All => format!(
            "(Complete: {running} running {}, {finished} finished {}.)",
            plural(running, "job", "jobs"),
            plural(finished, "record", "records")
        ),
    }
}

fn partial_job_list_terminal(
    status: JobListStatus,
    start: usize,
    shown: usize,
    total: usize,
    limit: u64,
) -> String {
    let first = start.saturating_add(1);
    let next = start.saturating_add(shown);
    format!(
        "(Partial: showing {first}-{next} of {total} {}. Call job_list again with status=\"{}\", limit={limit}, offset={next}.)",
        job_list_scope(status),
        job_list_status_name(status)
    )
}

fn job_list_scope(status: JobListStatus) -> &'static str {
    match status {
        JobListStatus::Running => "running jobs",
        JobListStatus::Finished => "finished records",
        JobListStatus::All => "jobs",
    }
}

fn job_list_status_name(status: JobListStatus) -> &'static str {
    match status {
        JobListStatus::Running => "running",
        JobListStatus::Finished => "finished",
        JobListStatus::All => "all",
    }
}

fn format_job_entry(record: &JobRecord) -> String {
    let status = match &record.status {
        JobStatus::Running => "running".to_string(),
        JobStatus::Exited(exit) if exit.was_killed() => "killed".to_string(),
        JobStatus::Exited(exit) => format!("exited {}", exit.exit_code),
        JobStatus::Interrupted => "interrupted".to_string(),
    };
    format!(
        "{}  {status}; started {}\n  {} — {}",
        record.id,
        record.meta.started_at,
        single_line(&record.meta.cwd),
        truncate_command(&record.meta.command)
    )
}

fn truncate_command(command: &str) -> String {
    let command = single_line(command);
    let mut characters = command.chars();
    let prefix = characters.by_ref().take(120).collect::<String>();
    if characters.next().is_some() {
        format!("{prefix}…")
    } else {
        prefix
    }
}

fn single_line(value: &str) -> String {
    value
        .chars()
        .flat_map(|character| {
            if character.is_control() {
                character.escape_default().collect::<Vec<_>>()
            } else {
                vec![character]
            }
        })
        .collect()
}

fn compose_list(entries: &[String], terminal: &str) -> String {
    if entries.is_empty() {
        terminal.to_string()
    } else {
        format!("{}\n\n{terminal}", entries.join("\n\n"))
    }
}

fn missing_job(job_id: &str) -> ToolResponse {
    ToolResponse::error(missing_job_text(job_id))
}

fn missing_job_text(job_id: &str) -> String {
    format!(
        "No such job: \"{job_id}\". It may never have existed, or its finished record was evicted by the job storage limit. List known jobs with job_list."
    )
}

fn global_terminal(terminal: String) -> ToolResponse {
    match global_token_budget() {
        Ok(budget) => terminal_response(terminal, budget),
        Err(error) => ToolResponse::error(error),
    }
}

pub(crate) fn summaries(paths: &ControlPaths) -> Result<Vec<JobSummary>, JobRegistryError> {
    let mut records = store::scan_registry(&paths.jobs_dir)?.records;
    records.sort_by(
        |left, right| match (left.status.is_running(), right.status.is_running()) {
            (true, false) => std::cmp::Ordering::Less,
            (false, true) => std::cmp::Ordering::Greater,
            (true, true) => store::started_sort_key(right).cmp(&store::started_sort_key(left)),
            (false, false) => right
                .ended_sort_key
                .cmp(&left.ended_sort_key)
                .then_with(|| right.id.cmp(&left.id)),
        },
    );
    Ok(records
        .into_iter()
        .map(|record| {
            let source_key = format!(
                "{}:{}:{}",
                record.meta.origin.server_pid,
                record
                    .meta
                    .origin
                    .server_started
                    .as_deref()
                    .unwrap_or("legacy"),
                record.meta.origin.server_cwd
            );
            let source = JobSourceSummary {
                tag: source_tag(&source_key),
                key: source_key,
                server_pid: record.meta.origin.server_pid,
                parent_executable: record.meta.origin.parent_executable,
                server_cwd: record.meta.origin.server_cwd,
            };
            JobSummary {
                id: record.id,
                command: record.meta.command,
                cwd: record.meta.cwd,
                started_at: record.meta.started_at,
                status: match record.status {
                    JobStatus::Running => JobSummaryStatus::Running,
                    JobStatus::Exited(exit) => JobSummaryStatus::Exited(exit.exit_code),
                    JobStatus::Interrupted => JobSummaryStatus::Interrupted,
                },
                source,
            }
        })
        .collect())
}

/// Runs one admission-serialized history maintenance pass without starting a new job.
pub(crate) fn reap_history(paths: &ControlPaths) -> Result<u64, String> {
    let _admission = admission::AdmissionGuard::acquire(paths)?;
    let limits = store::effective_limits(paths)?;
    store::reap(paths, limits.storage_limit_mib)
}

fn source_tag(source_key: &str) -> String {
    let hash = source_key
        .bytes()
        .fold(0xcbf2_9ce4_8422_2325_u64, |hash, byte| {
            (hash ^ u64::from(byte)).wrapping_mul(0x0000_0100_0000_01b3)
        });
    format!("{:06x}", hash & 0x00ff_ffff)
}

pub(crate) fn running_summaries(paths: &ControlPaths) -> Result<Vec<JobSummary>, String> {
    Ok(summaries(paths)?
        .into_iter()
        .filter(|job| job.status == JobSummaryStatus::Running)
        .collect())
}

pub(crate) fn reap(paths: &ControlPaths) -> Result<u64, String> {
    let _admission = admission::AdmissionGuard::acquire(paths)?;
    let limits = store::effective_limits(paths)?;
    store::reap(paths, limits.storage_limit_mib)
}

#[cfg(unix)]
pub(crate) fn run_bootstrap_entry() -> Result<(), String> {
    match host::run_bootstrap() {
        Ok(()) => Ok(()),
        Err(error) => {
            host::write_startup_error(&error);
            Err(error)
        }
    }
}

pub(crate) fn run_host_entry() -> Result<(), String> {
    host::run_job_host()
}

#[cfg(unix)]
pub(crate) fn run_watchdog_entry(pid: u32, started: String) -> Result<(), String> {
    host::run_watchdog(pid, started)
}

#[cfg(test)]
mod tests {
    use super::{OutputSnapshot, format_snapshot};
    use crate::budget::TokenBudget;

    use crate::shell::jobs::model::{
        CaptureErrorRecord, ExitRecord, JobStatus, StoredLine, TerminationKind,
    };
    use std::path::PathBuf;

    fn exited(code: i32, ended_order: u64) -> JobStatus {
        JobStatus::Exited(ExitRecord {
            exit_code: code,
            total_lines: 0,
            had_loss: false,
            ended_at: "2026-07-16T10:00:09Z".to_string(),
            ended_at_unix_nanos: ended_order,
            termination: TerminationKind::Exited,
            capture_error: None,
            output_truncation: None,
        })
    }

    #[test]
    fn direct_and_legacy_terminals_keep_their_capability_promises_separate() {
        let budget = TokenBudget {
            value: 8_500,
            variable: "FASTCTX_TOKEN_BUDGET",
        };
        let interrupted = format_snapshot(
            "j-000001",
            0,
            &OutputSnapshot {
                status: JobStatus::Interrupted,
                head: Vec::new(),
                tail: Vec::new(),
                unread_first: 4,
                unread_last: 3,
                all_unread_loaded: true,
                total_lines: 3,
                legacy_loss: false,
                capture_error: None,
                output_truncation: None,
                default_encoding: None,
                anchor: 3,
                direct_log: Some(PathBuf::from("/jobs/j-000001/output.log")),
            },
            None,
            budget,
        )
        .unwrap();
        assert!(interrupted.response.contains("Full log:"));
        assert!(interrupted.response.contains("output.log"));

        let capture = format_snapshot(
            "j-000002",
            0,
            &OutputSnapshot {
                status: exited(17, 1),
                head: vec![StoredLine {
                    seq: 1,
                    bytes: b"kept".to_vec(),
                    total_bytes: 4,
                    stream_encoding: None,
                    legacy_text: None,
                    known_truncated: false,
                }],
                tail: Vec::new(),
                unread_first: 1,
                unread_last: 1,
                all_unread_loaded: true,
                total_lines: 2,
                legacy_loss: true,
                capture_error: Some(CaptureErrorRecord {
                    after_seq: 1,
                    reason: "disk unavailable".to_string(),
                }),
                output_truncation: None,
                default_encoding: None,
                anchor: 0,
                direct_log: None,
            },
            None,
            budget,
        )
        .unwrap();
        assert!(capture.response.contains("this legacy record stops here"));
        assert!(capture.response.contains("cannot be retrieved"));
        assert!(!capture.response.contains("Full log:"));
        assert!(!capture.response.contains("offset="));
    }

    #[test]
    fn a_capture_failure_on_a_direct_log_keeps_the_exit_status_and_points_at_the_log() {
        let budget = TokenBudget {
            value: 8_500,
            variable: "FASTCTX_TOKEN_BUDGET",
        };
        let rendered = format_snapshot(
            "j-000003",
            0,
            &OutputSnapshot {
                status: exited(17, 1),
                head: vec![StoredLine {
                    seq: 1,
                    bytes: b"output".to_vec(),
                    total_bytes: 6,
                    stream_encoding: None,
                    legacy_text: None,
                    known_truncated: false,
                }],
                tail: Vec::new(),
                unread_first: 1,
                unread_last: 1,
                all_unread_loaded: true,
                total_lines: 1,
                legacy_loss: false,
                capture_error: Some(CaptureErrorRecord {
                    after_seq: 1,
                    reason: "disk unavailable".to_string(),
                }),
                output_truncation: None,
                default_encoding: None,
                anchor: 0,
                direct_log: Some(PathBuf::from("/jobs/j-000003/output.log")),
            },
            None,
            budget,
        )
        .unwrap();
        assert!(
            rendered
                .response
                .contains("output capture failed after seq 1: disk unavailable"),
            "{}",
            rendered.response
        );
        assert!(
            rendered
                .response
                .contains("This does not kill the process; its exit status remains available"),
            "{}",
            rendered.response
        );
        assert!(
            rendered.response.contains("output.log") && rendered.response.contains("stops here.)"),
            "{}",
            rendered.response
        );
        assert!(
            rendered.response.contains("exited 17"),
            "{}",
            rendered.response
        );
        assert!(!rendered.response.contains("legacy record"));
    }
}
