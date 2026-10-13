// Modified by dsh-ops (https://github.com/T-Auto/dsh-ops): removed the TUI-only editable-input parser and its error type, which the deleted src/tui/ editors were the only callers of.
//! Shared detection and validation for grep/glob CPU parallelism.

use std::fmt;

/// Hard ceiling for effective `P`: one request-local base lane plus shared extra lanes.
pub(crate) const MAX_SEARCH_PARALLELISM: usize = 16;

/// Resolved search parallelism using the same ceiling as the executor.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) struct SearchParallelism {
    /// Engine-visible CPU ceiling derived from `available_parallelism`.
    pub(crate) available: usize,
    /// Explicit user limit, or `None` for automatic parallelism.
    pub(crate) configured: Option<usize>,
    /// Effective `P`, including the request-local base lane.
    pub(crate) effective: usize,
}

/// Range failure for a typed persisted CPU limit.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) struct SearchParallelismRangeError {
    pub(crate) maximum: usize,
}

impl fmt::Display for SearchParallelismRangeError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(
            formatter,
            "must be an integer in 1..={} or omitted for automatic parallelism",
            self.maximum
        )
    }
}

/// Detects the exact upper bound used by the search executor.
pub(crate) fn detected_available() -> usize {
    std::thread::available_parallelism()
        .map(usize::from)
        .unwrap_or(1)
        .clamp(1, MAX_SEARCH_PARALLELISM)
}

/// Resolves an optional persisted limit against the current engine-visible ceiling.
pub(crate) fn resolve(
    configured: Option<i64>,
) -> Result<SearchParallelism, SearchParallelismRangeError> {
    resolve_with_available(configured, detected_available())
}

fn resolve_with_available(
    configured: Option<i64>,
    available: usize,
) -> Result<SearchParallelism, SearchParallelismRangeError> {
    let available = available.clamp(1, MAX_SEARCH_PARALLELISM);
    let configured = configured
        .map(|value| validate(value, available))
        .transpose()?;
    Ok(SearchParallelism {
        available,
        configured,
        effective: configured.unwrap_or(available),
    })
}

fn validate(value: i64, maximum: usize) -> Result<usize, SearchParallelismRangeError> {
    usize::try_from(value)
        .ok()
        .filter(|value| (1..=maximum).contains(value))
        .ok_or(SearchParallelismRangeError { maximum })
}

#[cfg(test)]
mod tests {
    use super::{MAX_SEARCH_PARALLELISM, resolve_with_available};

    #[test]
    fn engine_ceiling_and_configured_limit_share_one_resolution_path() {
        let automatic = resolve_with_available(None, 64).unwrap();
        assert_eq!(automatic.available, MAX_SEARCH_PARALLELISM);
        assert_eq!(automatic.configured, None);
        assert_eq!(automatic.effective, MAX_SEARCH_PARALLELISM);

        let configured = resolve_with_available(Some(4), 64).unwrap();
        assert_eq!(configured.available, MAX_SEARCH_PARALLELISM);
        assert_eq!(configured.configured, Some(4));
        assert_eq!(configured.effective, 4);

        let fallback_machine = resolve_with_available(None, 0).unwrap();
        assert_eq!(fallback_machine.available, 1);
        assert_eq!(fallback_machine.effective, 1);
    }

    #[test]
    fn persisted_limits_accept_both_boundaries_and_reject_every_out_of_range_shape() {
        for value in [1, 4, 8] {
            let resolved = resolve_with_available(Some(value), 8).unwrap();
            assert_eq!(resolved.configured, Some(value as usize));
            assert_eq!(resolved.effective, value as usize);
        }
        for value in [i64::MIN, -1, 0, 9, i64::MAX] {
            let error = resolve_with_available(Some(value), 8).unwrap_err();
            assert_eq!(error.maximum, 8);
        }
    }
}
