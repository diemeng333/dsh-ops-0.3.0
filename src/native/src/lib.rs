#![forbid(unsafe_code)]
mod batch;
pub mod contract;
mod file;
mod file_path;
mod paths;
mod results;
mod store;
use cap_std::{ambient_authority, fs::Dir};
use contract::*;
use serde_json::Value;

pub fn dispatch(request: Request) -> Result<Value> {
    if request.scope.is_empty()
        || request.scope.len() > 256
        || !std::path::Path::new(&request.root).is_absolute()
    {
        return Err(Failure::new(
            "INVALID_ARGUMENT",
            "An absolute workspace root and a bounded scope identity are required",
        ));
    }
    let root = std::fs::canonicalize(&request.root)?;
    let mut request = Request {
        root: root
            .to_str()
            .ok_or_else(|| Failure::new("INVALID_ARGUMENT", "Non-UTF8 root"))?
            .into(),
        ..request
    };
    // File reads/searches do not create or consult the durable audit store.
    // This is important for read-only sessions and keeps observation separate
    // from mutation audit records.
    if matches!(request.tool.as_str(), "inspect_local_file" | "glob" | "grep" | "replace") {
        request.root_identity = String::new();
        return file::dispatch(&request);
    }
    let dir = Dir::open_ambient_dir(root, ambient_authority())?;
    use cap_fs_ext::MetadataExt;
    let metadata = dir.dir_metadata()?;
    request.root_identity = format!("{}:{}", metadata.dev(), metadata.ino());
    if request.read_only
        && !(request.tool == "result"
            && request.args.get("action").and_then(Value::as_str) == Some("page"))
    {
        return Err(Failure::new(
            "POLICY_DENIED",
            "Read-only requests cannot mutate audit or result storage",
        ));
    }
    let store = store::Store::open(&dir, request.read_only)?;
    match request.tool.as_str() {
        "batch" => batch::run(&dir, &store, &request),
        "result" => results::run(&store, &request),
        _ => Err(Failure::new("INVALID_ARGUMENT", "Unknown capability")),
    }
}
