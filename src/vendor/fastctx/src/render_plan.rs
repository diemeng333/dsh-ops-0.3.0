//! Immutable response units, exact prefix checkpoints, and one-shot final rendering.

use crate::budget::{ExactPrefixCounter, TokenCheckpoint, TokenCountError};
#[cfg(test)]
use crate::operation::TestStage;
use crate::operation::{WorkCheckpoint, WorkStop};
use std::collections::HashMap;
use std::fmt;
use std::sync::Arc;

/// A fully assembled response whose incremental and independent token counts agree.
#[derive(Debug)]
pub(crate) struct VerifiedRender {
    pub(crate) text: String,
    pub(crate) tokens: usize,
}

/// Failures that must stop output instead of risking a truncated response.
#[derive(Debug)]
pub(crate) enum RenderPlanError {
    Token(TokenCountError),
    InvalidPrefix { shown: usize, available: usize },
    InvalidTerminal,
    CountMismatch { incremental: usize, full: usize },
    OverBudget { tokens: usize, budget: usize },
}

impl RenderPlanError {
    pub(crate) fn is_cancelled(&self) -> bool {
        matches!(
            self,
            Self::Token(TokenCountError::Stopped(WorkStop::RequestCancelled))
        )
    }
}

impl fmt::Display for RenderPlanError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Token(error) => error.fmt(formatter),
            Self::InvalidPrefix { shown, available } => write!(
                formatter,
                "The renderer selected {shown} entries from only {available} available entries."
            ),
            Self::InvalidTerminal => formatter.write_str(
                "The renderer received a terminal note outside the grep compatibility grammar.",
            ),
            Self::CountMismatch { incremental, full } => write!(
                formatter,
                "Internal token-count invariant failed: incremental={incremental}, full={full}."
            ),
            Self::OverBudget { tokens, budget } => write!(
                formatter,
                "The selected render uses {tokens} tokens but its budget is {budget}."
            ),
        }
    }
}

impl From<TokenCountError> for RenderPlanError {
    fn from(error: TokenCountError) -> Self {
        Self::Token(error)
    }
}

/// Lines rendered exactly once, with an exact tokenizer checkpoint after every prefix.
pub(crate) struct LineRenderGraph {
    lines: Vec<Arc<str>>,
    checkpoints: Vec<TokenCheckpoint>,
    counter: ExactPrefixCounter,
}

impl LineRenderGraph {
    pub(crate) fn new(
        lines: Vec<Arc<str>>,
        operation: Option<&dyn WorkCheckpoint>,
    ) -> Result<Self, RenderPlanError> {
        let mut counter = ExactPrefixCounter::default();
        let mut checkpoints = Vec::with_capacity(lines.len().saturating_add(1));
        checkpoints.push(counter.checkpoint());
        for (index, line) in lines.iter().enumerate() {
            check_render_work(operation, TestRenderStage::Unit)?;
            if index > 0 {
                counter.append("\n", operation)?;
            }
            counter.append(line, operation)?;
            checkpoints.push(counter.checkpoint());
        }

        Ok(Self {
            lines,
            checkpoints,
            counter,
        })
    }

    /// Returns the immutable tokenizer state at one body-entry prefix.
    pub(crate) fn checkpoint(&self, shown: usize) -> Result<TokenCheckpoint, RenderPlanError> {
        self.checkpoints
            .get(shown)
            .cloned()
            .ok_or(RenderPlanError::InvalidPrefix {
                shown,
                available: self.lines.len(),
            })
    }

    /// Counts a prefix plus its notes using only the checkpoint tail and short trailer.
    pub(crate) fn probe_notes<T: AsRef<str>>(
        &mut self,
        shown: usize,
        notes: &[T],
        operation: Option<&dyn WorkCheckpoint>,
    ) -> Result<usize, RenderPlanError> {
        check_render_work(operation, TestRenderStage::TokenProbe)?;
        let checkpoint = self
            .checkpoints
            .get(shown)
            .ok_or(RenderPlanError::InvalidPrefix {
                shown,
                available: self.lines.len(),
            })?;
        let trailer = render_notes_suffix(shown, notes);
        self.counter
            .count_with_suffix(checkpoint, &trailer, operation)
            .map_err(Into::into)
    }

    /// Assembles the selected view once, then independently verifies the full text once.
    pub(crate) fn finish<T: AsRef<str>>(
        &mut self,
        shown: usize,
        notes: &[T],
        incremental_tokens: usize,
        budget: usize,
        operation: Option<&dyn WorkCheckpoint>,
    ) -> Result<VerifiedRender, RenderPlanError> {
        if shown > self.lines.len() {
            return Err(RenderPlanError::InvalidPrefix {
                shown,
                available: self.lines.len(),
            });
        }
        check_render_work(operation, TestRenderStage::Unit)?;
        let mut text = String::new();
        for (index, line) in self.lines[..shown].iter().enumerate() {
            if index > 0 {
                text.push('\n');
            }
            text.push_str(line);
        }
        if !notes.is_empty() {
            if shown > 0 {
                text.push_str("\n\n");
            }
            for (index, note) in notes.iter().enumerate() {
                if index > 0 {
                    text.push('\n');
                }
                text.push_str(note.as_ref());
            }
        }

        check_render_work(operation, TestRenderStage::FinalVerify)?;
        let full_tokens = self.counter.verify_full(&text, operation)?;
        if full_tokens != incremental_tokens {
            return Err(RenderPlanError::CountMismatch {
                incremental: incremental_tokens,
                full: full_tokens,
            });
        }
        if full_tokens > budget {
            return Err(RenderPlanError::OverBudget {
                tokens: full_tokens,
                budget,
            });
        }
        Ok(VerifiedRender {
            text,
            tokens: full_tokens,
        })
    }
}

#[derive(Clone)]
pub(crate) struct LineRenderView {
    lines: Arc<[Arc<str>]>,
    checkpoint: TokenCheckpoint,
}

impl LineRenderView {
    pub(crate) fn len(&self) -> usize {
        self.lines.len()
    }

    pub(crate) fn checkpoint(&self) -> &TokenCheckpoint {
        &self.checkpoint
    }
}

struct SharedPrefixNode {
    checkpoint: TokenCheckpoint,
    children: HashMap<Arc<str>, usize>,
}

/// A request-local prefix trie for multiple compatibility views whose line
/// sequences overlap but are not necessarily prefixes of one maximum view.
pub(crate) struct SharedLineRenderGraph {
    nodes: Vec<SharedPrefixNode>,
}

impl SharedLineRenderGraph {
    pub(crate) fn new() -> Self {
        let counter = ExactPrefixCounter::default();
        Self {
            nodes: vec![SharedPrefixNode {
                checkpoint: counter.checkpoint(),
                children: HashMap::new(),
            }],
        }
    }

    /// Interns one immutable line view, tokenizing only prefix edges that no
    /// earlier compatibility probe has already established.
    pub(crate) fn prepare_view(
        &mut self,
        lines: Vec<Arc<str>>,
        operation: Option<&dyn WorkCheckpoint>,
    ) -> Result<LineRenderView, RenderPlanError> {
        let mut node_index = 0_usize;
        for (depth, line) in lines.iter().enumerate() {
            check_render_work(operation, TestRenderStage::Unit)?;
            if let Some(child) = self.nodes[node_index].children.get(line).copied() {
                node_index = child;
                continue;
            }

            let parent_checkpoint = self.nodes[node_index].checkpoint.clone();
            let mut counter = ExactPrefixCounter::from_checkpoint(&parent_checkpoint);
            if depth > 0 {
                counter.append("\n", operation)?;
            }
            counter.append(line, operation)?;
            let child = self.nodes.len();
            self.nodes.push(SharedPrefixNode {
                checkpoint: counter.checkpoint(),
                children: HashMap::new(),
            });
            self.nodes[node_index]
                .children
                .insert(Arc::clone(line), child);
            node_index = child;
        }
        Ok(LineRenderView {
            lines: Arc::from(lines),
            checkpoint: self.nodes[node_index].checkpoint.clone(),
        })
    }

    pub(crate) fn probe_notes<T: AsRef<str>>(
        &mut self,
        view: &LineRenderView,
        notes: &[T],
        operation: Option<&dyn WorkCheckpoint>,
    ) -> Result<usize, RenderPlanError> {
        check_render_work(operation, TestRenderStage::TokenProbe)?;
        let suffix = render_notes_suffix(view.len(), notes);
        let mut counter = ExactPrefixCounter::from_checkpoint(&view.checkpoint);
        counter
            .count_with_suffix(&view.checkpoint, &suffix, operation)
            .map_err(Into::into)
    }

    pub(crate) fn finish<T: AsRef<str>>(
        &mut self,
        view: &LineRenderView,
        notes: &[T],
        incremental_tokens: usize,
        budget: usize,
        operation: Option<&dyn WorkCheckpoint>,
    ) -> Result<VerifiedRender, RenderPlanError> {
        check_render_work(operation, TestRenderStage::Unit)?;
        let mut text = String::new();
        for (index, line) in view.lines.iter().enumerate() {
            if index > 0 {
                text.push('\n');
            }
            text.push_str(line);
        }
        if !notes.is_empty() {
            if !view.lines.is_empty() {
                text.push_str("\n\n");
            }
            for (index, note) in notes.iter().enumerate() {
                if index > 0 {
                    text.push('\n');
                }
                text.push_str(note.as_ref());
            }
        }

        check_render_work(operation, TestRenderStage::FinalVerify)?;
        let full_tokens = crate::budget::estimate_tokens(&text);
        check_render_work(operation, TestRenderStage::FinalVerify)?;
        if full_tokens != incremental_tokens {
            return Err(RenderPlanError::CountMismatch {
                incremental: incremental_tokens,
                full: full_tokens,
            });
        }
        if full_tokens > budget {
            return Err(RenderPlanError::OverBudget {
                tokens: full_tokens,
                budget,
            });
        }
        Ok(VerifiedRender {
            text,
            tokens: full_tokens,
        })
    }
}

/// Exact checkpoints for an optional prefix of diagnostic detail lines after a fixed body.
pub(crate) struct DetailRenderGraph {
    prefix_has_body: bool,
    fixed_lines: usize,
    detail_lines: usize,
    checkpoints: Vec<TokenCheckpoint>,
    counter: ExactPrefixCounter,
}

impl DetailRenderGraph {
    pub(crate) fn new(
        body_checkpoint: &TokenCheckpoint,
        prefix_has_body: bool,
        fixed_lines: &[Arc<str>],
        detail_lines: &[Arc<str>],
        operation: Option<&dyn WorkCheckpoint>,
    ) -> Result<Self, RenderPlanError> {
        let mut counter = ExactPrefixCounter::from_checkpoint(body_checkpoint);
        let mut note_count = 0_usize;
        for line in fixed_lines {
            append_note_line(&mut counter, line, prefix_has_body, note_count, operation)?;
            note_count = note_count.saturating_add(1);
        }
        let mut checkpoints = Vec::with_capacity(detail_lines.len().saturating_add(1));
        checkpoints.push(counter.checkpoint());
        for line in detail_lines {
            append_note_line(&mut counter, line, prefix_has_body, note_count, operation)?;
            note_count = note_count.saturating_add(1);
            checkpoints.push(counter.checkpoint());
        }
        Ok(Self {
            prefix_has_body,
            fixed_lines: fixed_lines.len(),
            detail_lines: detail_lines.len(),
            checkpoints,
            counter,
        })
    }

    /// Counts the selected detail prefix plus mandatory trailing note lines.
    pub(crate) fn probe_tail<T: AsRef<str>>(
        &mut self,
        shown_details: usize,
        tail_lines: &[T],
        operation: Option<&dyn WorkCheckpoint>,
    ) -> Result<usize, RenderPlanError> {
        check_render_work(operation, TestRenderStage::TokenProbe)?;
        let checkpoint =
            self.checkpoints
                .get(shown_details)
                .ok_or(RenderPlanError::InvalidPrefix {
                    shown: shown_details,
                    available: self.detail_lines,
                })?;
        let existing_notes = self.fixed_lines.saturating_add(shown_details);
        let suffix = render_continuation_suffix(self.prefix_has_body, existing_notes, tail_lines);
        self.counter
            .count_with_suffix(checkpoint, &suffix, operation)
            .map_err(Into::into)
    }
}

fn append_note_line(
    counter: &mut ExactPrefixCounter,
    line: &str,
    prefix_has_body: bool,
    existing_notes: usize,
    operation: Option<&dyn WorkCheckpoint>,
) -> Result<(), RenderPlanError> {
    if existing_notes > 0 {
        counter.append("\n", operation)?;
    } else if prefix_has_body {
        counter.append("\n\n", operation)?;
    }
    counter.append(line, operation)?;
    Ok(())
}

fn render_continuation_suffix<T: AsRef<str>>(
    prefix_has_body: bool,
    existing_notes: usize,
    lines: &[T],
) -> String {
    if lines.is_empty() {
        return String::new();
    }
    let mut suffix = String::new();
    if existing_notes > 0 {
        suffix.push('\n');
    } else if prefix_has_body {
        suffix.push_str("\n\n");
    }
    for (index, line) in lines.iter().enumerate() {
        if index > 0 {
            suffix.push('\n');
        }
        suffix.push_str(line.as_ref());
    }
    suffix
}

fn render_notes_suffix<T: AsRef<str>>(shown: usize, notes: &[T]) -> String {
    if notes.is_empty() {
        return String::new();
    }
    let mut suffix = String::new();
    if shown > 0 {
        suffix.push_str("\n\n");
    }
    for (index, note) in notes.iter().enumerate() {
        if index > 0 {
            suffix.push('\n');
        }
        suffix.push_str(note.as_ref());
    }
    suffix
}

#[derive(Clone, Copy)]
enum TestRenderStage {
    Unit,
    TokenProbe,
    FinalVerify,
}

fn check_render_work(
    operation: Option<&dyn WorkCheckpoint>,
    stage: TestRenderStage,
) -> Result<(), RenderPlanError> {
    if let Some(operation) = operation {
        operation.check_work().map_err(TokenCountError::Stopped)?;
        #[cfg(test)]
        operation.stage(match stage {
            TestRenderStage::Unit => TestStage::RenderUnit,
            TestRenderStage::TokenProbe => TestStage::TokenProbe,
            TestRenderStage::FinalVerify => TestStage::BeforeFinalTokenVerify,
        });
        #[cfg(not(test))]
        let _ = stage;
        operation.check_work().map_err(TokenCountError::Stopped)?;
    } else {
        let _ = stage;
    }
    Ok(())
}
