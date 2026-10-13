//! Stable manifest for tool grouping, gating, and contract hashes.

use rmcp::model::Tool;
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet};

/// One independently gated tool group in the single server.
#[derive(Clone, Copy, Debug, Eq, Ord, PartialEq, PartialOrd, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum ToolGroup {
    /// Always-published file inspection and replacement tools.
    File,
    /// Optional bash execution and background-job tools.
    Shell,
}

impl ToolGroup {
    /// Returns whether this group is published for the startup flags.
    pub const fn enabled(self, enable_shell: bool) -> bool {
        match self {
            Self::File => true,
            Self::Shell => enable_shell,
        }
    }
}

/// Compile-time enumerable facts for one tool.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct ToolManifestEntry {
    /// MCP tool name without the server namespace.
    pub name: &'static str,
    /// Gate controlling publication.
    pub group: ToolGroup,
}

/// One published tool's stable doctor contract.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ToolContract {
    /// MCP tool name without the server namespace.
    pub name: String,
    /// Manifest group.
    pub group: ToolGroup,
    /// SHA-256 over name, description, input schema, annotations, and group.
    pub hash: String,
}

const TOOL_ENTRIES: [ToolManifestEntry; 9] = [
    ToolManifestEntry {
        name: "inspect_local_file",
        group: ToolGroup::File,
    },
    ToolManifestEntry {
        name: "grep",
        group: ToolGroup::File,
    },
    ToolManifestEntry {
        name: "glob",
        group: ToolGroup::File,
    },
    ToolManifestEntry {
        name: "replace",
        group: ToolGroup::File,
    },
    ToolManifestEntry {
        name: "run",
        group: ToolGroup::Shell,
    },
    ToolManifestEntry {
        name: "run_background",
        group: ToolGroup::Shell,
    },
    ToolManifestEntry {
        name: "job_output",
        group: ToolGroup::Shell,
    },
    ToolManifestEntry {
        name: "job_kill",
        group: ToolGroup::Shell,
    },
    ToolManifestEntry {
        name: "job_list",
        group: ToolGroup::Shell,
    },
];

/// Access to the single source of enumerable tool facts.
pub struct ToolManifest;

impl ToolManifest {
    /// Returns all nine manifest entries in stable presentation order.
    pub const fn entries() -> &'static [ToolManifestEntry] {
        &TOOL_ENTRIES
    }

    /// Returns expected names for one startup flag combination.
    pub fn expected_names(enable_shell: bool) -> Vec<&'static str> {
        TOOL_ENTRIES
            .iter()
            .filter(|entry| entry.group.enabled(enable_shell))
            .map(|entry| entry.name)
            .collect()
    }

    /// Validates names and explicit permission annotations against the manifest.
    pub fn validate(tools: &[Tool], enable_shell: bool) -> Result<(), String> {
        let mut name_counts = BTreeMap::<&str, usize>::new();
        for tool in tools {
            *name_counts.entry(tool.name.as_ref()).or_default() += 1;
        }
        let duplicates = name_counts
            .into_iter()
            .filter_map(|(name, count)| (count > 1).then_some(name))
            .collect::<Vec<_>>();
        if !duplicates.is_empty() {
            return Err(format!(
                "tool router contains duplicate names: {}",
                duplicates.join(", ")
            ));
        }

        let expected = Self::expected_names(enable_shell)
            .into_iter()
            .collect::<BTreeSet<_>>();
        let actual = tools
            .iter()
            .map(|tool| tool.name.as_ref())
            .collect::<BTreeSet<_>>();
        if actual != expected {
            return Err(format!(
                "tool router names differ from ToolManifest: expected {expected:?}, got {actual:?}"
            ));
        }
        for tool in tools {
            let annotations = tool
                .annotations
                .as_ref()
                .ok_or_else(|| format!("tool {} is missing annotations", tool.name))?;
            if annotations.read_only_hint.is_none()
                || annotations.destructive_hint.is_none()
                || annotations.open_world_hint.is_none()
            {
                return Err(format!(
                    "tool {} must explicitly declare readOnlyHint, destructiveHint, and openWorldHint",
                    tool.name
                ));
            }
            let expected_read_only = matches!(
                tool.name.as_ref(),
                "inspect_local_file" | "grep" | "glob" | "job_output" | "job_list"
            );
            if annotations.read_only_hint != Some(expected_read_only)
                || annotations.destructive_hint != Some(false)
                || annotations.open_world_hint != Some(false)
            {
                return Err(format!(
                    "tool {} has incorrect permission annotations: expected readOnlyHint={expected_read_only}, destructiveHint=false, openWorldHint=false",
                    tool.name
                ));
            }
        }
        Ok(())
    }

    /// Builds stable doctor contracts for a visible tool list.
    pub fn contracts(tools: &[Tool]) -> Result<Vec<ToolContract>, String> {
        let groups = TOOL_ENTRIES
            .iter()
            .map(|entry| (entry.name, entry.group))
            .collect::<BTreeMap<_, _>>();
        let mut seen = BTreeSet::new();
        let mut contracts = tools
            .iter()
            .map(|tool| {
                if !seen.insert(tool.name.as_ref()) {
                    return Err(format!(
                        "tool router contains duplicate name: {}",
                        tool.name
                    ));
                }
                let group = groups
                    .get(tool.name.as_ref())
                    .copied()
                    .ok_or_else(|| format!("tool {} has no ToolManifest entry", tool.name))?;
                Ok(ToolContract {
                    name: tool.name.to_string(),
                    group,
                    hash: contract_hash(tool, group),
                })
            })
            .collect::<Result<Vec<_>, String>>()?;
        contracts.sort_by(|left, right| left.name.cmp(&right.name));
        Ok(contracts)
    }
}

fn contract_hash(tool: &Tool, group: ToolGroup) -> String {
    #[derive(Serialize)]
    struct ContractHashInput<'a> {
        name: &'a str,
        description: Option<&'a str>,
        input_schema: &'a serde_json::Map<String, serde_json::Value>,
        annotations: &'a Option<rmcp::model::ToolAnnotations>,
        group: ToolGroup,
    }

    let bytes = serde_json::to_vec(&ContractHashInput {
        name: tool.name.as_ref(),
        description: tool.description.as_deref(),
        input_schema: tool.input_schema.as_ref(),
        annotations: &tool.annotations,
        group,
    })
    .expect("tool contract fields are serializable");
    hex::encode(Sha256::digest(bytes))
}

#[cfg(test)]
mod tests {
    use super::{ToolGroup, ToolManifest, contract_hash};
    use crate::server::{FastCtxServer, ServerOptions};
    use std::collections::BTreeSet;

    #[test]
    fn enabled_combinations_have_the_frozen_counts_and_order() {
        assert_eq!(ToolManifest::expected_names(false).len(), 4);
        assert_eq!(ToolManifest::expected_names(true).len(), 9);
        assert_eq!(ToolManifest::entries()[0].group, ToolGroup::File);
        assert_eq!(ToolManifest::entries()[3].name, "replace");
        assert_eq!(ToolManifest::entries()[8].name, "job_list");
    }

    #[test]
    fn validation_rejects_duplicate_names_and_annotation_drift() {
        let mut tools = FastCtxServer::new().tool_definitions();
        let duplicate = tools
            .iter()
            .find(|tool| tool.name == "inspect_local_file")
            .unwrap()
            .clone();
        tools.push(duplicate);
        assert_eq!(
            ToolManifest::validate(&tools, false).unwrap_err(),
            "tool router contains duplicate names: inspect_local_file"
        );
        assert_eq!(
            ToolManifest::contracts(&tools).unwrap_err(),
            "tool router contains duplicate name: inspect_local_file"
        );

        let mut missing = FastCtxServer::new().tool_definitions();
        missing
            .iter_mut()
            .find(|tool| tool.name == "inspect_local_file")
            .unwrap()
            .annotations = None;
        assert_eq!(
            ToolManifest::validate(&missing, false).unwrap_err(),
            "tool inspect_local_file is missing annotations"
        );

        let mut incorrect = FastCtxServer::new().tool_definitions();
        incorrect
            .iter_mut()
            .find(|tool| tool.name == "inspect_local_file")
            .unwrap()
            .annotations
            .as_mut()
            .unwrap()
            .open_world_hint = Some(true);
        assert_eq!(
            ToolManifest::validate(&incorrect, false).unwrap_err(),
            "tool inspect_local_file has incorrect permission annotations: expected readOnlyHint=true, destructiveHint=false, openWorldHint=false"
        );
    }

    #[test]
    fn contract_hash_covers_every_contract_field() {
        let tool = FastCtxServer::new()
            .tool_definitions()
            .into_iter()
            .find(|tool| tool.name == "inspect_local_file")
            .unwrap();
        let before = contract_hash(&tool, ToolGroup::File);

        let mut changed_name = tool.clone();
        changed_name.name = "changed".into();
        assert_ne!(before, contract_hash(&changed_name, ToolGroup::File));

        let mut changed_description = tool.clone();
        changed_description.description = Some("changed description".into());
        assert_ne!(before, contract_hash(&changed_description, ToolGroup::File));

        let mut changed_schema = tool.clone();
        std::sync::Arc::make_mut(&mut changed_schema.input_schema)
            .insert("changed".into(), serde_json::Value::Bool(true));
        assert_ne!(before, contract_hash(&changed_schema, ToolGroup::File));

        let mut changed_annotations = tool.clone();
        changed_annotations
            .annotations
            .as_mut()
            .unwrap()
            .open_world_hint = Some(true);
        assert_ne!(before, contract_hash(&changed_annotations, ToolGroup::File));

        assert_ne!(before, contract_hash(&tool, ToolGroup::Shell));
    }

    /// Underscore-shaped identifiers model-visible prose may cite even though no tool,
    /// parameter, or schema enum vouches for them.
    const DOCUMENTED_PROSE_LITERALS: [&str; 2] = [
        // The job_list page-size setting cited by the limit parameter's description.
        "job_list_limit",
        // A WHATWG encoding label used as an example value in encoding parameters.
        "shift_jis",
    ];

    fn all_published_tools() -> Vec<rmcp::model::Tool> {
        FastCtxServer::with_options(ServerOptions::all()).tool_definitions()
    }

    /// Labelled model-visible prose plus the identifier vocabulary the same surface
    /// publishes: tool names, every schema property name, and every schema enum value.
    fn model_visible_prose_and_vocabulary() -> (Vec<(String, String)>, BTreeSet<String>) {
        let mut vocabulary: BTreeSet<String> = ToolManifest::entries()
            .iter()
            .map(|entry| entry.name.to_string())
            .collect();
        vocabulary.extend(
            DOCUMENTED_PROSE_LITERALS
                .iter()
                .map(|literal| literal.to_string()),
        );
        let mut prose = vec![(
            "server instructions".to_string(),
            crate::model_guidance::server_instructions(true),
        )];
        for tool in all_published_tools() {
            if let Some(description) = tool.description.as_deref() {
                prose.push((
                    format!("{} description", tool.name),
                    description.to_string(),
                ));
            }
            if let Some(title) = tool
                .annotations
                .as_ref()
                .and_then(|entry| entry.title.clone())
            {
                prose.push((format!("{} title", tool.name), title));
            }
            let schema = serde_json::Value::Object((*tool.input_schema).clone());
            collect_schema_prose_and_vocabulary(&schema, &tool.name, &mut prose, &mut vocabulary);
        }
        (prose, vocabulary)
    }

    fn collect_schema_prose_and_vocabulary(
        value: &serde_json::Value,
        tool: &str,
        prose: &mut Vec<(String, String)>,
        vocabulary: &mut BTreeSet<String>,
    ) {
        match value {
            serde_json::Value::Object(map) => {
                for (key, entry) in map {
                    match (key.as_str(), entry) {
                        ("properties", serde_json::Value::Object(properties)) => {
                            vocabulary.extend(properties.keys().cloned());
                        }
                        ("enum", serde_json::Value::Array(values)) => {
                            for value in values {
                                if let serde_json::Value::String(text) = value {
                                    vocabulary.insert(text.clone());
                                }
                            }
                        }
                        ("description", serde_json::Value::String(text)) => {
                            prose.push((format!("{tool} schema"), text.clone()));
                        }
                        _ => {}
                    }
                    collect_schema_prose_and_vocabulary(entry, tool, prose, vocabulary);
                }
            }
            serde_json::Value::Array(entries) => {
                for entry in entries {
                    collect_schema_prose_and_vocabulary(entry, tool, prose, vocabulary);
                }
            }
            _ => {}
        }
    }

    /// Tokens of lowercase letters, digits, and underscores; only those containing an
    /// underscore are identifier-shaped. Hyphenated words split, so "single-file" never
    /// counts, while possessives shed their tail ("inspect_local_file's" resolves).
    fn identifier_tokens(text: &str) -> Vec<String> {
        split_tokens(text, |character: char| {
            character.is_ascii_lowercase() || character.is_ascii_digit() || character == '_'
        })
        .into_iter()
        .map(|token| token.trim_matches('_').to_string())
        .filter(|token| token.contains('_'))
        .collect()
    }

    /// Word tokens where '-' and '\'' bind, so "re-read" and "read's" survive as single
    /// tokens distinct from the bare word "read".
    fn word_tokens(text: &str) -> Vec<String> {
        split_tokens(text, |character: char| {
            character.is_ascii_lowercase()
                || character.is_ascii_digit()
                || matches!(character, '_' | '-' | '\'')
        })
    }

    fn split_tokens(text: &str, keep: impl Fn(char) -> bool) -> Vec<String> {
        let mut tokens = Vec::new();
        let mut current = String::new();
        for character in text.chars() {
            if keep(character) {
                current.push(character);
            } else if !current.is_empty() {
                tokens.push(std::mem::take(&mut current));
            }
        }
        if !current.is_empty() {
            tokens.push(current);
        }
        tokens
    }

    /// The file tool shipped as `read` through 0.2.4, and renaming it stranded prose in
    /// other tools' descriptions that still cited the old name. Every underscore-shaped
    /// identifier in model-visible prose must resolve against the published vocabulary so
    /// a rename can never strand references again (2026-08-08).
    #[test]
    fn model_visible_prose_cites_only_published_identifiers() {
        let (prose, vocabulary) = model_visible_prose_and_vocabulary();
        for (context, text) in &prose {
            for token in identifier_tokens(&text.to_lowercase()) {
                assert!(
                    vocabulary.contains(&token),
                    "{context} cites `{token}`, which no published tool, parameter, or documented value resolves; full text: {text}"
                );
            }
        }
    }

    /// `read` was the file tool's name for three releases, so any standalone "read" in
    /// model-visible prose still presents it as callable. Prose must pick another verb or
    /// name inspect_local_file outright; hyphenated forms like "re-read" stay legal
    /// (2026-08-08).
    #[test]
    fn model_visible_prose_never_says_bare_read() {
        let (prose, _) = model_visible_prose_and_vocabulary();
        for (context, text) in &prose {
            for token in word_tokens(&text.to_lowercase()) {
                assert!(
                    token != "read" && token != "read's",
                    "{context} says bare `read`, the file tool's retired name; full text: {text}"
                );
            }
        }
    }
}
