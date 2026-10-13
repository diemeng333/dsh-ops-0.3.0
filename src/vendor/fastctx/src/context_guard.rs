//! Per-session aggregate output admission for Guarded provider routes.

use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

/// Calls completing within this interval remain in the same model-turn burst.
pub(crate) const BURST_GAP: Duration = Duration::from_secs(1);
/// Minimum formatter allowance after the shared pool can no longer fund a normal response.
pub(crate) const STUB_TOKEN_BUDGET: usize = 128;
/// Codex 0.147.0's inner auto-to-effective buffer for a 272K model catalog entry.
pub(crate) const INNER_COMPACTION_BUFFER: usize = 13_600;
/// Absolute text-accounting ceiling; one token remains between FastCtx and Codex's buffer.
pub(crate) const BURST_HARD_TOKEN_LIMIT: usize = INNER_COMPACTION_BUFFER - 1;

/// Shared output state owned by one MCP connection, never by the per-user runtime.
#[derive(Debug)]
pub(crate) struct GuardedBurstPool {
    token_budget: usize,
    gap: Duration,
    state: Mutex<BurstState>,
}

#[derive(Debug)]
struct BurstState {
    generation: u64,
    active_calls: usize,
    unclaimed_calls: usize,
    spent_tokens: usize,
    reserved_tokens: usize,
    last_completed: Option<Instant>,
}

impl GuardedBurstPool {
    pub(crate) fn new(token_budget: usize, gap: Duration) -> Arc<Self> {
        Arc::new(Self {
            token_budget,
            gap,
            state: Mutex::new(BurstState {
                generation: 0,
                active_calls: 0,
                unclaimed_calls: 0,
                spent_tokens: 0,
                reserved_tokens: 0,
                last_completed: None,
            }),
        })
    }

    pub(crate) fn begin(self: &Arc<Self>) -> BurstTicket {
        self.begin_at(Instant::now())
    }

    fn begin_at(self: &Arc<Self>, now: Instant) -> BurstTicket {
        let mut state = self.state.lock().expect("Guarded burst state was poisoned");
        let starts_new = state.active_calls == 0
            && state
                .last_completed
                .is_none_or(|completed| now.saturating_duration_since(completed) >= self.gap);
        if starts_new {
            state.generation = state.generation.wrapping_add(1);
            state.spent_tokens = 0;
            state.reserved_tokens = 0;
        }
        state.active_calls = state.active_calls.saturating_add(1);
        state.unclaimed_calls = state.unclaimed_calls.saturating_add(1);
        BurstTicket {
            pool: Arc::clone(self),
            generation: state.generation,
            active: true,
        }
    }

    #[cfg(test)]
    fn spent_tokens(&self) -> usize {
        self.state
            .lock()
            .expect("Guarded burst state was poisoned")
            .spent_tokens
    }
}

/// Arrival record that keeps queued sibling calls visible to later render-time allocation.
#[must_use]
pub(crate) struct BurstTicket {
    pool: Arc<GuardedBurstPool>,
    generation: u64,
    active: bool,
}

impl BurstTicket {
    /// Reserves a fair render allowance among calls that have not yet claimed one.
    pub(crate) fn claim(mut self, normal_budget: usize) -> BurstClaim {
        let (allowance, exhausted) = {
            let mut state = self
                .pool
                .state
                .lock()
                .expect("Guarded burst state was poisoned");
            debug_assert_eq!(state.generation, self.generation);
            debug_assert!(state.unclaimed_calls > 0);
            let remaining = self
                .pool
                .token_budget
                .saturating_sub(state.spent_tokens.saturating_add(state.reserved_tokens));
            let hard_remaining = BURST_HARD_TOKEN_LIMIT
                .saturating_sub(state.spent_tokens.saturating_add(state.reserved_tokens));
            let fair_share = remaining / state.unclaimed_calls;
            let allowance = normal_budget
                .min(fair_share.max(STUB_TOKEN_BUDGET))
                .min(hard_remaining);
            state.unclaimed_calls -= 1;
            state.reserved_tokens = state.reserved_tokens.saturating_add(allowance);
            (
                allowance,
                remaining < STUB_TOKEN_BUDGET || hard_remaining < STUB_TOKEN_BUDGET,
            )
        };
        self.active = false;
        BurstClaim {
            pool: Arc::clone(&self.pool),
            generation: self.generation,
            allowance,
            exhausted,
            active: true,
        }
    }
}

impl Drop for BurstTicket {
    fn drop(&mut self) {
        if !self.active {
            return;
        }
        let mut state = self
            .pool
            .state
            .lock()
            .expect("Guarded burst state was poisoned");
        debug_assert_eq!(state.generation, self.generation);
        state.active_calls = state.active_calls.saturating_sub(1);
        state.unclaimed_calls = state.unclaimed_calls.saturating_sub(1);
        state.last_completed = Some(Instant::now());
    }
}

/// Reserved formatter share; dropping it refunds the reservation after panic or cancellation.
#[must_use]
pub(crate) struct BurstClaim {
    pool: Arc<GuardedBurstPool>,
    generation: u64,
    allowance: usize,
    exhausted: bool,
    active: bool,
}

impl BurstClaim {
    pub(crate) const fn allowance(&self) -> usize {
        self.allowance
    }

    pub(crate) const fn exhausted(&self) -> bool {
        self.exhausted
    }

    pub(crate) fn complete(mut self, actual_tokens: usize) {
        self.complete_at(actual_tokens, Instant::now());
    }

    fn complete_at(&mut self, actual_tokens: usize, now: Instant) {
        if !self.active {
            return;
        }
        let mut state = self
            .pool
            .state
            .lock()
            .expect("Guarded burst state was poisoned");
        debug_assert_eq!(state.generation, self.generation);
        state.reserved_tokens = state.reserved_tokens.saturating_sub(self.allowance);
        state.spent_tokens = state.spent_tokens.saturating_add(actual_tokens);
        state.active_calls = state.active_calls.saturating_sub(1);
        state.last_completed = Some(now);
        self.active = false;
    }
}

impl Drop for BurstClaim {
    fn drop(&mut self) {
        if !self.active {
            return;
        }
        let mut state = self
            .pool
            .state
            .lock()
            .expect("Guarded burst state was poisoned");
        debug_assert_eq!(state.generation, self.generation);
        state.reserved_tokens = state.reserved_tokens.saturating_sub(self.allowance);
        state.active_calls = state.active_calls.saturating_sub(1);
        state.last_completed = Some(Instant::now());
    }
}

#[cfg(test)]
mod tests {
    use super::{
        BURST_GAP, BURST_HARD_TOKEN_LIMIT, GuardedBurstPool, INNER_COMPACTION_BUFFER,
        STUB_TOKEN_BUDGET,
    };
    use std::time::{Duration, Instant};

    const POOL: usize = 9_000;

    #[test]
    fn three_overlapping_calls_receive_equal_render_shares() {
        let now = Instant::now();
        let pool = GuardedBurstPool::new(POOL, BURST_GAP);
        let tickets = [pool.begin_at(now), pool.begin_at(now), pool.begin_at(now)];
        let claims = tickets.map(|ticket| ticket.claim(POOL));
        assert_eq!(claims.each_ref().map(|claim| claim.allowance()), [3_000; 3]);
        for mut claim in claims {
            let allowance = claim.allowance();
            claim.complete_at(allowance, now);
        }
        assert_eq!(pool.spent_tokens(), POOL);
    }

    #[test]
    fn same_turn_serial_calls_keep_the_spent_pool_and_next_turn_resets_it() {
        let now = Instant::now();
        let pool = GuardedBurstPool::new(POOL, BURST_GAP);
        let mut first = pool.begin_at(now).claim(POOL);
        assert_eq!(first.allowance(), POOL);
        first.complete_at(POOL, now);

        let mut same_turn = pool.begin_at(now + Duration::from_millis(100)).claim(POOL);
        assert_eq!(same_turn.allowance(), STUB_TOKEN_BUDGET);
        assert!(same_turn.exhausted());
        same_turn.complete_at(0, now + Duration::from_millis(100));

        let next_turn = pool
            .begin_at(now + BURST_GAP + Duration::from_millis(100))
            .claim(POOL);
        assert_eq!(next_turn.allowance(), POOL);
    }

    #[test]
    fn session_pools_never_share_spend() {
        let now = Instant::now();
        let first = GuardedBurstPool::new(POOL, BURST_GAP);
        let second = GuardedBurstPool::new(POOL, BURST_GAP);
        let mut spent = first.begin_at(now).claim(POOL);
        spent.complete_at(POOL, now);
        assert_eq!(
            second
                .begin_at(now + Duration::from_millis(10))
                .claim(POOL)
                .allowance(),
            POOL
        );
    }

    #[test]
    fn every_simultaneous_tool_lane_stays_inside_the_inner_compaction_buffer() {
        // The runtime admits at most 8 file + 16 shell + 8 replace formatters at once.
        const MAX_SIMULTANEOUS_FORMATTERS: usize = 32;
        const {
            assert!(
                POOL + (MAX_SIMULTANEOUS_FORMATTERS - 1) * STUB_TOKEN_BUDGET
                    < INNER_COMPACTION_BUFFER
            );
        }
    }

    #[test]
    fn an_unbounded_same_burst_sequence_can_never_cross_the_hard_buffer() {
        let now = Instant::now();
        let pool = GuardedBurstPool::new(POOL, BURST_GAP);
        for index in 0..1_000_u64 {
            let mut claim = pool
                .begin_at(now + Duration::from_micros(index))
                .claim(POOL);
            let worst_case = claim.allowance();
            claim.complete_at(worst_case, now + Duration::from_micros(index));
        }
        assert_eq!(pool.spent_tokens(), BURST_HARD_TOKEN_LIMIT);
        assert!(pool.spent_tokens() < INNER_COMPACTION_BUFFER);
    }
}
