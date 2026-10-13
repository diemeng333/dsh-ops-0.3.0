//! Shared positive/negative path-glob filtering for file tools.

use globset::{GlobBuilder, GlobSet, GlobSetBuilder};
use schemars::JsonSchema;
use serde::Deserialize;
use std::path::Path;

/// One glob or an ordered collection of globs.
///
/// A leading `!` marks an exclusion. Exclusions always veto a match; when at
/// least one inclusion is present, a path must match an inclusion first.
///
/// Parameters of this type publish the array form alone, because a union is the
/// one construct no provider's tool-schema subset accepts; see `crate::tool_schema`.
/// Both forms still deserialize, so callers written against either keep working.
#[derive(Clone, Debug, Deserialize, JsonSchema)]
#[serde(untagged)]
pub enum GlobPatterns {
    One(String),
    Many(Vec<String>),
}

impl GlobPatterns {
    fn values(&self) -> &[String] {
        match self {
            Self::One(pattern) => std::slice::from_ref(pattern),
            Self::Many(patterns) => patterns,
        }
    }
}

/// A compiled path filter whose exclusions take precedence over inclusions.
pub(crate) struct PathGlobFilter {
    inclusions: Option<GlobSet>,
    exclusions: Option<GlobSet>,
}

impl PathGlobFilter {
    pub(crate) fn compile(
        patterns: &GlobPatterns,
        literal_separator: bool,
    ) -> Result<Self, String> {
        let patterns = patterns.values();
        if patterns.is_empty() {
            return Err("the pattern list is empty".to_string());
        }

        let mut inclusions = GlobSetBuilder::new();
        let mut exclusions = GlobSetBuilder::new();
        let mut inclusion_count = 0_usize;
        let mut exclusion_count = 0_usize;

        for raw in patterns {
            let (excluded, pattern) = match raw.strip_prefix('!') {
                Some("") => return Err("`!` must be followed by a glob pattern".to_string()),
                Some(pattern) => (true, pattern),
                None => (false, raw.as_str()),
            };
            let glob = GlobBuilder::new(pattern)
                .literal_separator(literal_separator)
                .build()
                .map_err(|error| error.to_string())?;
            if excluded {
                exclusions.add(glob);
                exclusion_count += 1;
            } else {
                inclusions.add(glob);
                inclusion_count += 1;
            }
        }

        Ok(Self {
            inclusions: build_set(inclusions, inclusion_count)?,
            exclusions: build_set(exclusions, exclusion_count)?,
        })
    }

    pub(crate) fn is_match(&self, path: impl AsRef<Path>) -> bool {
        let path = path.as_ref();
        let included = self
            .inclusions
            .as_ref()
            .is_none_or(|patterns| patterns.is_match(path));
        included
            && self
                .exclusions
                .as_ref()
                .is_none_or(|patterns| !patterns.is_match(path))
    }
}

fn build_set(builder: GlobSetBuilder, count: usize) -> Result<Option<GlobSet>, String> {
    if count == 0 {
        Ok(None)
    } else {
        builder.build().map(Some).map_err(|error| error.to_string())
    }
}
