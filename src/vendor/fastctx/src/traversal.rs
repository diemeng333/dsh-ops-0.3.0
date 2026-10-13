//! Shared project traversal with lossless search paths, partial results, and a
//! deterministic report of whatever the walk could not reach.

use crate::bounded_sort::sort_cancelable;
use crate::file_executor::{BurstUse, GrepGlobExecutor};
use crate::glob_filter::PathGlobFilter;
use crate::operation::OperationCtx;
#[cfg(test)]
use crate::operation::TestStage;
use crate::path_codec::{
    PathRecord, ResolvedRoot, RootKind, display_path as search_display_path,
    io_error_message as search_io_error_message,
};
use ignore::types::TypesBuilder;
use ignore::{DirEntry, WalkBuilder, WalkState};
use parking_lot::Mutex;
use std::collections::BTreeMap;
use std::fs;
use std::io;
use std::panic::{AssertUnwindSafe, catch_unwind};
use std::path::Path;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

pub(crate) const TRAVERSAL_BATCH_ITEMS: usize = 256;

/// Upper bound on skipped paths kept with full detail. A damaged tree can raise
/// far more failures than any response could carry, so detail is bounded while
/// the tally stays exact.
const SKIPPED_DETAIL_CAP: usize = 256;

/// Legacy replace candidate retained while search uses `PathRecord` directly.
#[derive(Debug)]
pub(crate) struct ProjectCandidate {
    pub(crate) display: String,
}

/// The schedule-independent ordering key for one traversal failure.
#[derive(Clone, Debug, Eq, Ord, PartialEq, PartialOrd)]
pub(crate) struct TraversalErrorKey {
    /// Doubles as the reported path: `String` orders by the same bytes the key
    /// needs, so the failure never carries a second copy of it.
    pub(crate) display: String,
    pub(crate) kind_rank: u8,
    pub(crate) raw_os_error: Option<i32>,
    pub(crate) normalized_message: String,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct TraversalFailure {
    pub(crate) key: TraversalErrorKey,
    /// Standalone sentence used when the failure ends the whole request.
    pub(crate) message: String,
    /// Short cause phrase for skip reporting, where the path is already shown.
    reason: String,
}

/// Existing collection limit enforced at the first item beyond `maximum`.
#[derive(Clone, Copy)]
pub(crate) struct TraversalLimit {
    pub(crate) maximum: usize,
    pub(crate) message: &'static str,
}

/// One path a walk could not enter or evaluate.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) struct SkippedPath<'a> {
    pub(crate) display: &'a str,
    pub(crate) reason: &'a str,
}

/// Paths a walk had to skip, deduplicated by failure identity and ordered by the
/// same schedule-independent key the walk uses everywhere else, so the report is
/// identical across serial and parallel runs.
#[derive(Debug, Default)]
pub(crate) struct SkippedPaths {
    /// Keyed by failure identity; the value is that failure's cause phrase.
    entries: BTreeMap<TraversalErrorKey, String>,
    beyond_cap: usize,
    /// Lowest-ranked failure, kept verbatim for the paths that still fail whole.
    minimum: Option<(TraversalErrorKey, String)>,
}

/// Batched traversal output: what the walk collected, plus what it could not reach.
pub(crate) struct TraversalCollection<T> {
    pub(crate) items: Vec<T>,
    pub(crate) skipped: SkippedPaths,
}

impl SkippedPaths {
    fn record(&mut self, failure: TraversalFailure) {
        let TraversalFailure {
            key,
            message,
            reason,
        } = failure;
        if self
            .minimum
            .as_ref()
            .is_none_or(|(existing, _)| key < *existing)
        {
            self.minimum = Some((key.clone(), message));
        }
        self.insert(key, reason);
    }

    /// Past the cap the key is dropped, so repeats of an already-overflowed
    /// failure add to the tally again. Holding every key just to keep the count
    /// exact would defeat the bound the cap exists to provide, and a walk that
    /// raised more than `SKIPPED_DETAIL_CAP` distinct failures is already being
    /// told "large parts of this tree were not searched".
    fn insert(&mut self, key: TraversalErrorKey, reason: String) {
        if self.entries.contains_key(&key) {
            return;
        }
        if self.entries.len() < SKIPPED_DETAIL_CAP {
            self.entries.insert(key, reason);
        } else {
            self.beyond_cap = self.beyond_cap.saturating_add(1);
        }
    }

    fn merge(&mut self, other: Self) {
        if let Some((key, message)) = other.minimum
            && self
                .minimum
                .as_ref()
                .is_none_or(|(existing, _)| key < *existing)
        {
            self.minimum = Some((key, message));
        }
        for (key, reason) in other.entries {
            self.insert(key, reason);
        }
        self.beyond_cap = self.beyond_cap.saturating_add(other.beyond_cap);
    }

    /// The message a walk reports when the skip cannot be survived.
    fn root_failure_message(&self) -> Option<String> {
        self.minimum.as_ref().map(|(_, message)| message.clone())
    }

    /// Also answers "has anything been recorded at all": `record` always both
    /// sets `minimum` and lands in one of the two counters, so an empty report
    /// can never be hiding a failure the parallel merge would drop.
    pub(crate) fn is_empty(&self) -> bool {
        self.entries.is_empty() && self.beyond_cap == 0
    }

    /// Every skipped path, listed and unlisted alike; exact up to the cap.
    pub(crate) fn total(&self) -> usize {
        self.entries.len().saturating_add(self.beyond_cap)
    }

    /// Paths kept with full detail, in deterministic order.
    pub(crate) fn listed(&self) -> impl ExactSizeIterator<Item = SkippedPath<'_>> {
        self.entries.iter().map(|(key, reason)| SkippedPath {
            display: &key.display,
            reason,
        })
    }

    /// Paths counted but dropped from the detail list at the cap.
    pub(crate) fn unlisted(&self) -> usize {
        self.beyond_cap
    }
}

impl TraversalFailure {
    pub(crate) fn from_io(path: &Path, error: &io::Error) -> Self {
        Self {
            key: TraversalErrorKey {
                display: search_display_path(path),
                kind_rank: io_kind_rank(error.kind()),
                raw_os_error: error.raw_os_error(),
                normalized_message: normalize_error_message(&error.to_string()),
            },
            message: search_io_error_message(path, error),
            reason: io_reason(error),
        }
    }

    pub(crate) fn from_other(path: &Path, message: String, reason: String) -> Self {
        Self {
            key: TraversalErrorKey {
                display: search_display_path(path),
                kind_rank: u8::MAX,
                raw_os_error: None,
                normalized_message: normalize_error_message(&message),
            },
            message,
            reason,
        }
    }
}

/// Mirrors `path_codec::io_error_message`'s cases without repeating the path,
/// which skip reports already carry in their own column.
fn io_reason(error: &io::Error) -> String {
    #[cfg(windows)]
    if matches!(error.raw_os_error(), Some(32 | 33)) {
        return "locked by another process".to_string();
    }
    if error.kind() == io::ErrorKind::PermissionDenied {
        return "permission denied".to_string();
    }
    error.to_string()
}

/// Collects lossless grep candidates while reusing the root's sole metadata result.
pub(crate) fn collect_search_candidates(
    root: &ResolvedRoot,
    glob: Option<&PathGlobFilter>,
    file_type: Option<&str>,
    operation: Option<&OperationCtx>,
    executor: Option<&Arc<GrepGlobExecutor>>,
) -> Result<TraversalCollection<PathRecord>, String> {
    if operation_cancelled(operation) {
        return Err("Request cancelled.".to_string());
    }
    let type_filter = build_type_filter(file_type)?;
    let mut candidates = Vec::new();
    let mut skipped = SkippedPaths::default();
    if root.kind == RootKind::File {
        let candidate =
            PathRecord::from_metadata(&root.native, root.match_root(), &root.metadata, true)
                .map_err(|error| search_io_error_message(&root.native, &error))?;
        if matches_record(&candidate, glob, type_filter.as_ref()) {
            candidates.push(candidate);
        }
    } else {
        let collected = collect_directory_candidates(root, glob, type_filter, operation, executor)?;
        candidates = collected.items;
        skipped = collected.skipped;
    }
    let items = sort_cancelable(candidates, compare_search_candidates, operation, executor)
        .map(|sorted| sorted.items)
        .map_err(|error| error.to_string())?;
    Ok(TraversalCollection { items, skipped })
}

/// Collects files for replace while preserving its pre-codec display contract.
pub(crate) fn collect_project_candidates(
    root: &Path,
    glob: Option<&PathGlobFilter>,
    file_type: Option<&str>,
) -> Result<TraversalCollection<ProjectCandidate>, String> {
    let metadata =
        fs::metadata(root).map_err(|error| crate::paths::io_error_message(root, &error))?;
    let resolved = ResolvedRoot::from_metadata(root.to_path_buf(), metadata)?;
    collect_search_candidates(&resolved, glob, file_type, None, None).map(|collected| {
        TraversalCollection {
            items: collected
                .items
                .into_iter()
                .map(|candidate| ProjectCandidate {
                    display: crate::paths::display_path(&candidate.native),
                })
                .collect(),
            skipped: collected.skipped,
        }
    })
}

fn build_type_filter(file_type: Option<&str>) -> Result<Option<ignore::types::Types>, String> {
    let Some(file_type) = file_type else {
        return Ok(None);
    };
    let mut builder = TypesBuilder::new();
    builder.add_defaults();
    builder.select(file_type);
    builder.build().map(Some).map_err(|_| {
        format!(
            "Unknown file type: \"{file_type}\". Run with a glob filter instead, or use a standard type like js, py, rust, go, java."
        )
    })
}

fn collect_directory_candidates(
    root: &ResolvedRoot,
    glob: Option<&PathGlobFilter>,
    type_filter: Option<ignore::types::Types>,
    operation: Option<&OperationCtx>,
    executor: Option<&Arc<GrepGlobExecutor>>,
) -> Result<TraversalCollection<PathRecord>, String> {
    let mut builder = WalkBuilder::new(&root.native);
    builder
        .hidden(false)
        .ignore(true)
        .git_ignore(true)
        .git_global(true)
        .git_exclude(true)
        .follow_links(false)
        .filter_entry(|entry| entry.depth() == 0 || entry.file_name() != ".git");
    if let Some(types) = type_filter {
        builder.types(types);
    }

    collect_walk_batched(builder, &root.native, operation, executor, None, |entry| {
        if !entry
            .file_type()
            .is_some_and(|file_type| file_type.is_file() || file_type.is_symlink())
        {
            return Ok(None);
        }
        let preliminary = PathRecord::without_metadata(entry.path(), &root.native);
        if !matches_record(&preliminary, glob, None) {
            return Ok(None);
        }
        candidate_from_entry(entry, &root.native)
    })
}

/// Runs a true serial walker when no traversal credit is immediately available;
/// parallel walkers merge only fixed-size thread-local batches.
pub(crate) fn collect_walk_batched<T, F>(
    mut builder: WalkBuilder,
    root: &Path,
    operation: Option<&OperationCtx>,
    executor: Option<&Arc<GrepGlobExecutor>>,
    limit: Option<TraversalLimit>,
    evaluate: F,
) -> Result<TraversalCollection<T>, String>
where
    T: Send,
    F: Fn(&DirEntry) -> Result<Option<T>, TraversalFailure> + Send + Sync,
{
    if operation_cancelled(operation) {
        return Err("Request cancelled.".to_string());
    }
    let permits = executor
        .map(|executor| executor.try_bursts(executor.extra_capacity(), BurstUse::TraversalExtra))
        .unwrap_or_default();
    if permits.is_empty() {
        return collect_walk_serial(builder, root, operation, limit, &evaluate);
    }

    let thread_count = permits.len().saturating_add(1);
    builder.threads(thread_count);
    let shared = Mutex::new(ParallelCollectionState::<T>::default());
    let stop = AtomicBool::new(false);
    let cancelled = AtomicBool::new(false);
    let evaluate = &evaluate;
    let run = catch_unwind(AssertUnwindSafe(|| {
        builder.build_parallel().run(|| {
            let mut local = ParallelLocalBatch::new(&shared, &stop, &cancelled, operation, limit);
            Box::new(move |entry| {
                process_parallel_entry(entry, root, operation, evaluate, &mut local)
            })
        });
    }));
    drop(permits);
    if cancelled.load(Ordering::Acquire) || operation_cancelled(operation) {
        return Err("Request cancelled.".to_string());
    }
    if run.is_err() {
        return Err("Internal traversal worker failure.".to_string());
    }
    finish_parallel_collection(shared.into_inner(), limit)
}

fn collect_walk_serial<T, F>(
    builder: WalkBuilder,
    root: &Path,
    operation: Option<&OperationCtx>,
    limit: Option<TraversalLimit>,
    evaluate: &F,
) -> Result<TraversalCollection<T>, String>
where
    F: Fn(&DirEntry) -> Result<Option<T>, TraversalFailure>,
{
    let mut items = Vec::new();
    let mut skipped = SkippedPaths::default();
    let mut entries_seen = 0_usize;
    let mut too_many = false;
    for entry in builder.build() {
        stage_traversal_entry(operation);
        if operation_cancelled(operation) {
            return Err("Request cancelled.".to_string());
        }
        let entry = match entry {
            Ok(entry) => entry,
            Err(error) => {
                for failure in traversal_errors_from_ignore(&error, root) {
                    skipped.record(failure);
                }
                continue;
            }
        };
        entries_seen = entries_seen.saturating_add(1);
        let evaluated = catch_unwind(AssertUnwindSafe(|| evaluate(&entry)));
        match evaluated {
            Ok(Ok(Some(item))) => {
                if limit.is_some_and(|limit| items.len() >= limit.maximum) {
                    too_many = true;
                    break;
                }
                items.push(item);
            }
            Ok(Ok(None)) => {}
            Ok(Err(failure)) => skipped.record(failure),
            Err(_) => skipped.record(evaluation_panic(entry.path())),
        }
    }
    if operation_cancelled(operation) {
        return Err("Request cancelled.".to_string());
    }
    if too_many {
        return match limit {
            Some(limit) => Err(limit.message.to_string()),
            None => Err("Internal traversal limit state was inconsistent.".to_string()),
        };
    }
    finish_collection(items, skipped, entries_seen)
}

/// A walk that never yielded a single entry never happened: the root itself was
/// unreadable, so reporting it as "no results, some paths skipped" would read as
/// "searched, found nothing". Those still fail whole, with the message the walk
/// would have produced before partial results existed.
fn finish_collection<T>(
    items: Vec<T>,
    skipped: SkippedPaths,
    entries_seen: usize,
) -> Result<TraversalCollection<T>, String> {
    if entries_seen == 0
        && let Some(message) = skipped.root_failure_message()
    {
        return Err(message);
    }
    Ok(TraversalCollection { items, skipped })
}

fn evaluation_panic(path: &Path) -> TraversalFailure {
    TraversalFailure::from_other(
        path,
        "Internal traversal failure while evaluating a file candidate.".to_string(),
        "internal failure while evaluating this path".to_string(),
    )
}

struct ParallelCollectionState<T> {
    items: Vec<T>,
    skipped: SkippedPaths,
    entries_seen: usize,
    too_many: bool,
}

impl<T> Default for ParallelCollectionState<T> {
    fn default() -> Self {
        Self {
            items: Vec::new(),
            skipped: SkippedPaths::default(),
            entries_seen: 0,
            too_many: false,
        }
    }
}

struct ParallelLocalBatch<'a, T> {
    shared: &'a Mutex<ParallelCollectionState<T>>,
    stop: &'a AtomicBool,
    cancelled: &'a AtomicBool,
    operation: Option<&'a OperationCtx>,
    limit: Option<TraversalLimit>,
    items: Vec<T>,
    skipped: SkippedPaths,
    entries_seen: usize,
}

impl<'a, T> ParallelLocalBatch<'a, T> {
    fn new(
        shared: &'a Mutex<ParallelCollectionState<T>>,
        stop: &'a AtomicBool,
        cancelled: &'a AtomicBool,
        operation: Option<&'a OperationCtx>,
        limit: Option<TraversalLimit>,
    ) -> Self {
        Self {
            shared,
            stop,
            cancelled,
            operation,
            limit,
            items: Vec::with_capacity(TRAVERSAL_BATCH_ITEMS),
            skipped: SkippedPaths::default(),
            entries_seen: 0,
        }
    }

    fn push(&mut self, item: T) {
        self.items.push(item);
        if self.items.len() == TRAVERSAL_BATCH_ITEMS {
            self.flush();
        }
    }

    fn record_failure(&mut self, failure: TraversalFailure) {
        self.skipped.record(failure);
    }

    fn flush(&mut self) {
        if self.items.is_empty() && self.skipped.is_empty() && self.entries_seen == 0 {
            return;
        }
        stage_traversal_batch_flush(self.operation);
        if operation_cancelled(self.operation) {
            self.cancelled.store(true, Ordering::Release);
            self.stop.store(true, Ordering::Release);
            self.items.clear();
            self.skipped = SkippedPaths::default();
            self.entries_seen = 0;
            return;
        }

        let mut shared = self.shared.lock();
        shared.skipped.merge(std::mem::take(&mut self.skipped));
        shared.entries_seen = shared
            .entries_seen
            .saturating_add(std::mem::take(&mut self.entries_seen));
        for item in self.items.drain(..) {
            if self
                .limit
                .is_some_and(|limit| shared.items.len() >= limit.maximum)
            {
                shared.too_many = true;
                self.stop.store(true, Ordering::Release);
                break;
            }
            shared.items.push(item);
        }
        drop(shared);
        stage_traversal_batch_flush(self.operation);
        if operation_cancelled(self.operation) {
            self.cancelled.store(true, Ordering::Release);
            self.stop.store(true, Ordering::Release);
        }
    }
}

impl<T> Drop for ParallelLocalBatch<'_, T> {
    fn drop(&mut self) {
        self.flush();
    }
}

fn process_parallel_entry<'a, T, F>(
    entry: Result<DirEntry, ignore::Error>,
    root: &Path,
    operation: Option<&OperationCtx>,
    evaluate: &F,
    local: &mut ParallelLocalBatch<'a, T>,
) -> WalkState
where
    F: Fn(&DirEntry) -> Result<Option<T>, TraversalFailure>,
{
    if local.stop.load(Ordering::Acquire) {
        return WalkState::Quit;
    }
    stage_traversal_entry(operation);
    if operation_cancelled(operation) {
        local.cancelled.store(true, Ordering::Release);
        local.stop.store(true, Ordering::Release);
        return WalkState::Quit;
    }
    let entry = match entry {
        Ok(entry) => entry,
        Err(error) => {
            for failure in traversal_errors_from_ignore(&error, root) {
                local.record_failure(failure);
            }
            return WalkState::Continue;
        }
    };
    local.entries_seen = local.entries_seen.saturating_add(1);
    let evaluated = catch_unwind(AssertUnwindSafe(|| evaluate(&entry)));
    match evaluated {
        Ok(Ok(Some(item))) => local.push(item),
        Ok(Ok(None)) => {}
        Ok(Err(failure)) => local.record_failure(failure),
        Err(_) => local.record_failure(evaluation_panic(entry.path())),
    }
    if local.stop.load(Ordering::Acquire) {
        WalkState::Quit
    } else {
        WalkState::Continue
    }
}

fn finish_parallel_collection<T>(
    state: ParallelCollectionState<T>,
    limit: Option<TraversalLimit>,
) -> Result<TraversalCollection<T>, String> {
    if state.too_many {
        return match limit {
            Some(limit) => Err(limit.message.to_string()),
            None => Err("Internal traversal limit state was inconsistent.".to_string()),
        };
    }
    finish_collection(state.items, state.skipped, state.entries_seen)
}

fn compare_search_candidates(left: &PathRecord, right: &PathRecord) -> std::cmp::Ordering {
    right
        .modified
        .cmp(&left.modified)
        .then_with(|| left.display.as_bytes().cmp(right.display.as_bytes()))
        .then_with(|| left.native_key.cmp(&right.native_key))
}

fn matches_record(
    candidate: &PathRecord,
    glob: Option<&PathGlobFilter>,
    types: Option<&ignore::types::Types>,
) -> bool {
    if let Some(types) = types
        && !types.matched(&candidate.native, false).is_whitelist()
    {
        return false;
    }
    glob.is_none_or(|glob| glob.is_match(candidate.relative_match.as_ref()))
}

fn candidate_from_path(
    path: &Path,
    match_root: &Path,
) -> Result<Option<PathRecord>, TraversalFailure> {
    let metadata = match fs::metadata(path) {
        Ok(metadata) if metadata.is_file() => metadata,
        Ok(_) => return Ok(None),
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(TraversalFailure::from_io(path, &error)),
    };
    candidate_from_metadata(path, match_root, &metadata).map(Some)
}

/// Symlinks follow their target for the regular-file check and ordering metadata.
fn candidate_from_entry(
    entry: &ignore::DirEntry,
    match_root: &Path,
) -> Result<Option<PathRecord>, TraversalFailure> {
    if entry
        .file_type()
        .is_some_and(|file_type| file_type.is_symlink())
    {
        return candidate_from_path(entry.path(), match_root);
    }
    match entry.metadata() {
        Ok(metadata) if metadata.is_file() => {
            candidate_from_metadata(entry.path(), match_root, &metadata).map(Some)
        }
        Ok(_) => Ok(None),
        Err(_) => candidate_from_path(entry.path(), match_root),
    }
}

fn candidate_from_metadata(
    path: &Path,
    match_root: &Path,
    metadata: &fs::Metadata,
) -> Result<PathRecord, TraversalFailure> {
    PathRecord::from_metadata(path, match_root, metadata, true)
        .map_err(|error| TraversalFailure::from_io(path, &error))
}

fn operation_cancelled(operation: Option<&OperationCtx>) -> bool {
    operation.is_some_and(|operation| operation.check().is_err())
}

fn stage_traversal_entry(operation: Option<&OperationCtx>) {
    #[cfg(test)]
    if let Some(operation) = operation {
        operation.stage(TestStage::TraversalEntry);
    }
    #[cfg(not(test))]
    let _ = operation;
}

fn stage_traversal_batch_flush(operation: Option<&OperationCtx>) {
    #[cfg(test)]
    if let Some(operation) = operation {
        operation.stage(TestStage::TraversalBatchFlush);
    }
    #[cfg(not(test))]
    let _ = operation;
}

pub(crate) fn traversal_errors_from_ignore(
    error: &ignore::Error,
    root: &Path,
) -> Vec<TraversalFailure> {
    let mut failures = Vec::new();
    collect_ignore_error(error, None, root, &mut failures);
    failures
}

fn collect_ignore_error(
    error: &ignore::Error,
    inherited_path: Option<&Path>,
    root: &Path,
    failures: &mut Vec<TraversalFailure>,
) {
    match error {
        ignore::Error::Partial(errors) => {
            for error in errors {
                collect_ignore_error(error, inherited_path, root, failures);
            }
        }
        ignore::Error::WithLineNumber { err, .. } | ignore::Error::WithDepth { err, .. } => {
            collect_ignore_error(err, inherited_path, root, failures);
        }
        ignore::Error::WithPath { path, err } => {
            collect_ignore_error(err, Some(path), root, failures);
        }
        ignore::Error::Loop { child, .. } => failures.push(TraversalFailure::from_other(
            child,
            format!("Cannot traverse path: {error}"),
            error.to_string(),
        )),
        ignore::Error::Io(error) => failures.push(TraversalFailure::from_io(
            inherited_path.unwrap_or(root),
            error,
        )),
        ignore::Error::Glob { .. }
        | ignore::Error::UnrecognizedFileType(_)
        | ignore::Error::InvalidDefinition => failures.push(TraversalFailure::from_other(
            inherited_path.unwrap_or(root),
            format!("Cannot traverse path: {error}"),
            error.to_string(),
        )),
    }
}

fn normalize_error_message(message: &str) -> String {
    message.replace("\r\n", "\n").replace('\r', "\n")
}

fn io_kind_rank(kind: io::ErrorKind) -> u8 {
    match kind {
        io::ErrorKind::NotFound => 0,
        io::ErrorKind::PermissionDenied => 1,
        io::ErrorKind::WouldBlock => 2,
        io::ErrorKind::TimedOut => 3,
        io::ErrorKind::Interrupted => 4,
        io::ErrorKind::InvalidInput | io::ErrorKind::InvalidData => 5,
        io::ErrorKind::UnexpectedEof => 6,
        _ => 254,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn failure(path: &str) -> TraversalFailure {
        TraversalFailure::from_other(
            Path::new(path),
            format!("Cannot traverse path: {path}"),
            format!("reason for {path}"),
        )
    }

    fn listing(skipped: &SkippedPaths) -> Vec<(String, String)> {
        skipped
            .listed()
            .map(|path| (path.display.to_string(), path.reason.to_string()))
            .collect()
    }

    /// The defect this whole module exists to prevent: one unreadable corner of a
    /// tree used to discard every result collected around it.
    #[test]
    fn a_failure_inside_the_tree_keeps_the_items_around_it() {
        let dir = tempfile::TempDir::new().expect("temp dir");
        for name in ["a.txt", "b.txt", "c.txt"] {
            fs::write(dir.path().join(name), "x").expect("seed");
        }
        let collected = collect_walk_serial(
            WalkBuilder::new(dir.path()),
            dir.path(),
            None,
            None,
            &|entry: &DirEntry| -> Result<Option<PathBuf>, TraversalFailure> {
                if !entry.file_type().is_some_and(|kind| kind.is_file()) {
                    return Ok(None);
                }
                if entry.file_name() == "b.txt" {
                    return Err(failure("b.txt"));
                }
                Ok(Some(entry.path().to_path_buf()))
            },
        )
        .expect("a failure inside the tree must not fail the walk");
        assert_eq!(collected.items.len(), 2);
        assert_eq!(collected.skipped.total(), 1);
    }

    /// A walk with nothing to report on cannot claim it searched: an unreadable
    /// root must stay an error rather than become "found nothing".
    #[test]
    fn a_walk_that_never_reached_an_entry_still_fails_whole() {
        let dir = tempfile::TempDir::new().expect("temp dir");
        let missing = dir.path().join("missing");
        let error = collect_walk_serial(
            WalkBuilder::new(&missing),
            &missing,
            None,
            None,
            &|_: &DirEntry| -> Result<Option<PathBuf>, TraversalFailure> { Ok(None) },
        )
        .map(|collected| collected.items)
        .expect_err("an unreachable root has no partial result to offer");
        assert!(!error.is_empty());
    }

    /// Parallel walkers merge thread-local batches in scheduling order, so the
    /// report has to be a function of the failures alone.
    #[test]
    fn skip_reports_stay_identical_regardless_of_arrival_order() {
        let record = |paths: &[&str]| {
            let mut skipped = SkippedPaths::default();
            for path in paths {
                skipped.record(failure(path));
            }
            skipped
        };
        let forward = record(&["/a", "/b", "/c"]);
        let mut merged = record(&["/c"]);
        merged.merge(record(&["/b", "/a"]));
        assert_eq!(listing(&forward), listing(&merged));
        assert_eq!(forward.total(), merged.total());

        let mut duplicated = record(&["/a", "/a", "/a"]);
        duplicated.merge(record(&["/a"]));
        assert_eq!(duplicated.total(), 1);

        let flood = (0..SKIPPED_DETAIL_CAP + 40)
            .map(|index| format!("/flood/{index:05}"))
            .collect::<Vec<_>>();
        let overflowed = record(&flood.iter().map(String::as_str).collect::<Vec<_>>());
        assert_eq!(overflowed.total(), flood.len());
        assert_eq!(overflowed.listed().len(), SKIPPED_DETAIL_CAP);
        assert_eq!(overflowed.unlisted(), 40);
    }
}
