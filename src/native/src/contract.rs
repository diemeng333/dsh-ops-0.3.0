//! Typed operation contracts, independent of DSH transport and presentation.
use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(deny_unknown_fields)]
pub struct Operation {
    pub op: Kind,
    pub path: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub to: Option<String>,
}
#[derive(Debug, Serialize, Deserialize, Clone, Copy, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum Kind {
    Copy,
    Move,
    Remove,
}
#[derive(Debug, Serialize, Deserialize, Clone, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum State {
    Pending,
    Unknown,
    Completed,
    Failed,
}
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct Item {
    pub operation: Operation,
    pub revision: String,
    pub logical_bytes: u64,
    pub entries: u64,
    pub state: State,
    pub error: Option<Failure>,
}
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct Job {
    pub version: u32,
    pub id: String,
    pub root: String,
    pub root_identity: String,
    pub scope: String,
    pub created: u64,
    pub protect: Vec<String>,
    pub items: Vec<Item>,
}
#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Failure {
    pub code: String,
    pub phase: Box<str>,
    pub retryable: bool,
    pub effect_state: Box<str>,
    pub next_action: Box<str>,
    pub message: String,
}
impl Failure {
    pub fn new(code: &str, message: impl ToString) -> Self {
        Self {
            code: code.into(),
            phase: "preflight".into(),
            retryable: false,
            effect_state: "none".into(),
            next_action: "Correct the request or inspect the manifest.".into(),
            message: message.to_string(),
        }
    }
    pub fn unknown(message: impl ToString) -> Self {
        let mut e = Self::new("RESULT_UNKNOWN", message);
        e.phase = "execute".into();
        e.effect_state = "unknown".into();
        e.next_action = "Inspect postconditions; never blindly retry this item.".into();
        e
    }
}
impl From<std::io::Error> for Failure {
    fn from(e: std::io::Error) -> Self {
        let code = match e.kind() {
            std::io::ErrorKind::NotFound => "NOT_FOUND",
            std::io::ErrorKind::PermissionDenied => "ACCESS_DENIED",
            std::io::ErrorKind::AlreadyExists => "REVISION_CONFLICT",
            _ => "IO_ERROR",
        };
        Self::new(code, e)
    }
}
impl From<serde_json::Error> for Failure {
    fn from(e: serde_json::Error) -> Self {
        Self::new("INVALID_ARGUMENT", e)
    }
}
pub type Result<T> = std::result::Result<T, Failure>;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Request {
    pub root: String,
    #[serde(default)]
    pub read_only: bool,
    #[serde(default)]
    pub root_identity: String,
    pub scope: String,
    pub tool: String,
    pub args: Value,
    #[serde(default)]
    pub job_id: Option<String>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct BatchArgs {
    pub action: String,
    #[serde(default)]
    pub operations: Vec<Operation>,
    pub operations_ref: Option<String>,
    #[serde(default)]
    pub protect: Vec<String>,
    pub id: Option<String>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct ResultArgs {
    pub action: String,
    pub id: Option<String>,
    pub items: Option<Vec<Value>>,
    #[serde(default)]
    pub offset: usize,
    pub limit: Option<usize>,
    pub max_bytes: Option<usize>,
    pub fields: Option<Vec<String>>,
    pub equals: Option<std::collections::BTreeMap<String, Value>>,
}
