//! Preflight, durable per-item transitions and conservative recovery.
use crate::{
    contract::*,
    paths,
    store::{Store, now},
};
use cap_std::fs::Dir;
use serde_json::{Value, json};
const MAX_OPERATIONS: usize = 512;

pub fn run(root: &Dir, store: &Store, request: &Request) -> Result<Value> {
    let mut args: BatchArgs = serde_json::from_value(request.args.clone())?;
    if let Some(id) = &args.operations_ref {
        if !args.operations.is_empty() || args.action == "resume" {
            return Err(Failure::new(
                "INVALID_ARGUMENT",
                "operationsRef replaces operations and cannot alter resume",
            ));
        }
        args.operations = crate::results::referenced_items(store, request, id)?
            .into_iter()
            .map(serde_json::from_value)
            .collect::<std::result::Result<Vec<Operation>, _>>()?;
    }
    match args.action.as_str() {
        "plan" | "run" => {
            if args.id.is_some()
                || args.operations.is_empty()
                || args.operations.len() > MAX_OPERATIONS
                || args.protect.len() > 128
            {
                return Err(Failure::new(
                    "INVALID_ARGUMENT",
                    "Supply 1..512 operations and at most 128 protected paths, without an ID",
                ));
            }
            let protect: Vec<_> = args
                .protect
                .iter()
                .map(|p| paths::relative(p))
                .collect::<Result<_>>()?;
            for path in &protect {
                let (dir, leaf) = paths::parent(root, path)?;
                match dir.symlink_metadata(&leaf) {
                    Ok(metadata) if paths::is_link(&metadata) => {
                        return Err(Failure::new(
                            "POLICY_DENIED",
                            "Protect the real path, not a symlink/junction alias",
                        ));
                    }
                    Ok(_) => (),
                    Err(e) if e.kind() == std::io::ErrorKind::NotFound => (),
                    Err(e) => return Err(e.into()),
                }
            }
            let mut operations = Vec::new();
            let mut touched = Vec::new();
            for mut operation in args.operations {
                operation.path = paths::relative(&operation.path)?;
                operation.to = operation.to.map(|p| paths::relative(&p)).transpose()?;
                if (operation.op == Kind::Remove) != operation.to.is_none() {
                    return Err(Failure::new(
                        "INVALID_ARGUMENT",
                        "copy/move require to; remove forbids to",
                    ));
                }
                for path in std::iter::once(&operation.path).chain(operation.to.iter()) {
                    if protect.iter().any(|p| paths::overlaps(path, p))
                        || touched.iter().any(|p: &String| paths::overlaps(path, p))
                    {
                        return Err(Failure::new(
                            "POLICY_DENIED",
                            "Protected, overlapping, cyclic or dependent batch paths",
                        ));
                    }
                    touched.push(path.clone());
                }
                if let Some(dest) = &operation.to
                    && paths::exists(root, dest)?
                {
                    return Err(Failure::new(
                        "REVISION_CONFLICT",
                        "Destination already exists; no overwrites",
                    ));
                }
                operations.push(operation);
            }
            // Every item is fully preflighted before any audit/execution begins.
            let mut items = Vec::new();
            for operation in operations {
                let snap = paths::snapshot(root, &operation.path, operation.op)?;
                items.push(Item {
                    operation,
                    revision: snap.revision,
                    logical_bytes: snap.bytes,
                    entries: snap.entries,
                    state: State::Pending,
                    error: None,
                });
            }
            let id = request
                .job_id
                .clone()
                .unwrap_or_else(|| format!("j-{}", uuid::Uuid::new_v4()));
            Store::validate_id(&id)?;
            if !id.starts_with("j-") {
                return Err(Failure::new("INVALID_ARGUMENT", "Invalid job ID"));
            }
            match store.latest(&id) {
                Ok(_) => {
                    return Err(Failure::new(
                        "REVISION_CONFLICT",
                        "Job already exists; use resume",
                    ));
                }
                Err(e) if e.code == "NOT_FOUND" => (),
                Err(e) => return Err(e),
            }
            let mut job = Job {
                version: 1,
                id,
                root: request.root.clone(),
                root_identity: request.root_identity.clone(),
                scope: request.scope.clone(),
                created: now(),
                protect,
                items,
            };
            store.save(&job.id, &job)?;
            if args.action == "run" {
                execute(root, store, &mut job)?;
            }
            Ok(summary(&job))
        }
        "resume" => {
            if !args.operations.is_empty() || !args.protect.is_empty() {
                return Err(Failure::new(
                    "INVALID_ARGUMENT",
                    "Resume cannot change targets or protections",
                ));
            }
            let id = args
                .id
                .ok_or_else(|| Failure::new("INVALID_ARGUMENT", "Resume requires id"))?;
            let mut job: Job = store.read(&id)?;
            authorize(&job, request)?;
            if job.id != id {
                return Err(Failure::new("POLICY_DENIED", "Manifest identity mismatch"));
            }
            validate_saved(&job)?;
            execute(root, store, &mut job)?;
            Ok(summary(&job))
        }
        _ => Err(Failure::new(
            "INVALID_ARGUMENT",
            "Expected plan, run or resume",
        )),
    }
}
pub fn authorize(job: &Job, request: &Request) -> Result<()> {
    if job.version != 1
        || job.scope != request.scope
        || job.root != request.root
        || job.root_identity != request.root_identity
    {
        return Err(Failure::new(
            "POLICY_DENIED",
            "Job scope, root or version mismatch",
        ));
    }
    Ok(())
}
fn validate_saved(job: &Job) -> Result<()> {
    if job.items.is_empty() || job.items.len() > MAX_OPERATIONS || job.protect.len() > 128 {
        return Err(Failure::new(
            "INVALID_ARGUMENT",
            "Invalid persisted job limits",
        ));
    }
    let protect: Vec<_> = job
        .protect
        .iter()
        .map(|p| paths::relative(p))
        .collect::<Result<_>>()?;
    let mut paths_seen: Vec<String> = Vec::new();
    for item in &job.items {
        let op = &item.operation;
        if (op.op == Kind::Remove) != op.to.is_none() {
            return Err(Failure::new(
                "INVALID_ARGUMENT",
                "Invalid persisted operation",
            ));
        }
        for raw in std::iter::once(&op.path).chain(op.to.iter()) {
            let p = paths::relative(raw)?;
            if protect.iter().any(|q| paths::overlaps(&p, q))
                || paths_seen.iter().any(|q| paths::overlaps(&p, q))
            {
                return Err(Failure::new(
                    "POLICY_DENIED",
                    "Invalid persisted protection or overlap",
                ));
            }
            paths_seen.push(p);
        }
    }
    Ok(())
}
fn postcondition(root: &Dir, item: &Item) -> Result<bool> {
    match item.operation.op {
        Kind::Remove => Ok(!paths::exists(root, &item.operation.path)?),
        Kind::Copy | Kind::Move => {
            let dest = item
                .operation
                .to
                .as_ref()
                .ok_or_else(|| Failure::new("INVALID_ARGUMENT", "Missing destination"))?;
            if !paths::exists(root, dest)? {
                return Ok(false);
            }
            let same = paths::snapshot(root, dest, Kind::Copy)?.revision == item.revision;
            Ok(same
                && (item.operation.op != Kind::Move || !paths::exists(root, &item.operation.path)?))
        }
    }
}
fn execute(root: &Dir, store: &Store, job: &mut Job) -> Result<()> {
    for index in 0..job.items.len() {
        let item = &job.items[index];
        if item.state == State::Completed {
            continue;
        }
        if item.state == State::Unknown {
            // An operation may have happened before cancellation / journal failure.
            // Verify only. No re-execution of unresolved partial effects.
            if postcondition(root, item).unwrap_or(false) {
                job.items[index].state = State::Completed;
                job.items[index].error = None;
                store.save(&job.id, job)?;
            }
            continue;
        }
        let op = item.operation.clone();
        let checked = (|| -> Result<()> {
            paths::relative(&op.path)?;
            for p in std::iter::once(&op.path).chain(op.to.iter()) {
                paths::relative(p)?;
                if job
                    .protect
                    .iter()
                    .any(|protected| paths::overlaps(p, protected))
                {
                    return Err(Failure::new("POLICY_DENIED", "Protected path"));
                }
            }
            if paths::snapshot(root, &op.path, op.op)?.revision != item.revision {
                return Err(Failure::new(
                    "REVISION_CONFLICT",
                    "Source changed since preflight",
                ));
            }
            if op
                .to
                .as_ref()
                .is_some_and(|p| paths::exists(root, p).unwrap_or(true))
            {
                return Err(Failure::new(
                    "REVISION_CONFLICT",
                    "Destination exists or cannot be checked",
                ));
            }
            Ok(())
        })();
        if let Err(e) = checked {
            job.items[index].state = State::Failed;
            job.items[index].error = Some(e);
            store.save(&job.id, job)?;
            continue;
        }
        // Write-ahead unknown must be durable before the first filesystem effect.
        job.items[index].state = State::Unknown;
        job.items[index].error = Some(Failure::unknown(
            "Interrupted before settlement; verify postconditions",
        ));
        if let Err(e) = store.save(&job.id, job) {
            return Err(Failure::unknown(format!(
                "Write-ahead audit persistence failed before this item; prior items may have completed: {}",
                e.message
            )));
        }
        let effect = (|| -> Result<()> {
            match op.op {
                Kind::Remove => paths::remove(root, &op.path)?,
                Kind::Copy | Kind::Move => {
                    let to = op
                        .to
                        .as_ref()
                        .ok_or_else(|| Failure::new("INVALID_ARGUMENT", "Missing destination"))?;
                    paths::copy(root, &op.path, to)?;
                    if paths::snapshot(root, to, Kind::Copy)?.revision != job.items[index].revision
                    {
                        return Err(Failure::unknown("Copy verification failed"));
                    }
                    if op.op == Kind::Move {
                        if paths::snapshot(root, &op.path, Kind::Move)?.revision
                            != job.items[index].revision
                        {
                            return Err(Failure::unknown(
                                "Source changed during copy; both paths retained",
                            ));
                        }
                        paths::remove(root, &op.path)?;
                    }
                }
            }
            if !postcondition(root, &job.items[index])? {
                return Err(Failure::unknown("Postcondition failed"));
            }
            Ok(())
        })();
        match effect {
            Ok(()) => {
                job.items[index].state = State::Completed;
                job.items[index].error = None;
            }
            Err(e) => {
                job.items[index].error =
                    Some(Failure::unknown(format!("{}: {}", e.code, e.message)))
            }
        }
        if let Err(e) = store.save(&job.id, job) {
            let mut error = Failure::unknown(format!(
                "Operation may have completed but audit settlement failed: {}",
                e.message
            ));
            error.code = e.code;
            return Err(error);
        }
    }
    Ok(())
}
pub fn summary(job: &Job) -> Value {
    let count = |state| job.items.iter().filter(|i| i.state == state).count();
    let completed = count(State::Completed);
    let failed = count(State::Failed);
    let unknown = count(State::Unknown);
    json!({ "id": job.id, "status": if completed == job.items.len() { "completed" } else if unknown > 0 { "unknown" } else if failed > 0 { "partial_completion" } else { "planned" },
        "phase": if completed+failed+unknown == 0 { "preflight" } else { "settled" }, "done": completed, "total": job.items.len(), "failed": failed, "unknown": unknown,
        "logicalBytes": job.items.iter().map(|i| i.logical_bytes).sum::<u64>(), "byteSemantics": "logical_path_bytes_not_physical_reclaimed_space",
        "detailsRef": job.id, "complete": false, "omitted": job.items.len(),
        "nextAction": if unknown > 0 { "Resume verifies unknown items only; inspect unresolved manifest entries before manual repair." } else { "Use ops_result page with detailsRef for complete per-item data." } })
}
