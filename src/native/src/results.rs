//! One bounded result-reference protocol; no second REPL or query language.
use crate::{
    batch,
    contract::*,
    store::{Store, now},
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

#[derive(Serialize, Deserialize)]
struct Record {
    version: u32,
    scope: String,
    root: String,
    root_identity: String,
    expires: u64,
    items: Vec<Value>,
}
const TTL: u64 = 86400;

pub fn referenced_items(store: &Store, request: &Request, id: &str) -> Result<Vec<Value>> {
    Store::validate_id(id)?;
    if !id.starts_with("r-") {
        return Err(Failure::new(
            "INVALID_ARGUMENT",
            "Operation references must be result records",
        ));
    }
    let record: Record = store.read(id)?;
    if record.version != 1
        || record.scope != request.scope
        || record.root != request.root
        || record.root_identity != request.root_identity
    {
        return Err(Failure::new("POLICY_DENIED", "Reference scope mismatch"));
    }
    if record.expires < now() {
        return Err(Failure::new(
            "REFERENCE_EXPIRED",
            "Result observation expired",
        ));
    }
    Ok(record.items)
}
pub fn run(store: &Store, request: &Request) -> Result<Value> {
    let args: ResultArgs = serde_json::from_value(request.args.clone())?;
    match args.action.as_str() {
        "put" => {
            if args.id.is_some() {
                return Err(Failure::new("INVALID_ARGUMENT", "put forbids id"));
            }
            let items = args
                .items
                .ok_or_else(|| Failure::new("INVALID_ARGUMENT", "put requires items"))?;
            if items.len() > 10_000 || items.iter().any(|i| !i.is_object()) {
                return Err(Failure::new(
                    "INVALID_ARGUMENT",
                    "put requires at most 10000 objects",
                ));
            }
            let id = format!("r-{}", uuid::Uuid::new_v4());
            let expires = now() + TTL;
            let total = items.len();
            store.save(
                &id,
                &Record {
                    version: 1,
                    scope: request.scope.clone(),
                    root: request.root.clone(),
                    root_identity: request.root_identity.clone(),
                    expires,
                    items,
                },
            )?;
            Ok(
                json!({ "id": id, "total": total, "expires": expires, "complete": false, "omitted": total, "nextAction": "Use page with this id; references grant no filesystem authority." }),
            )
        }
        "page" | "release" => {
            if args.items.is_some() {
                return Err(Failure::new(
                    "INVALID_ARGUMENT",
                    "page/release forbid items",
                ));
            }
            let id = args
                .id
                .as_deref()
                .ok_or_else(|| Failure::new("INVALID_ARGUMENT", "Reference id required"))?;
            Store::validate_id(id)?;
            let items = if id.starts_with("j-") {
                let job: Job = store.read(id)?;
                batch::authorize(&job, request)?;
                job.items
                    .into_iter()
                    .map(serde_json::to_value)
                    .collect::<std::result::Result<Vec<_>, _>>()?
            } else {
                let record: Record = store.read(id)?;
                if record.version != 1
                    || record.scope != request.scope
                    || record.root != request.root
                    || record.root_identity != request.root_identity
                {
                    return Err(Failure::new(
                        "POLICY_DENIED",
                        "Reference belongs to another scope",
                    ));
                }
                if record.expires < now() && args.action != "release" {
                    return Err(Failure::new(
                        "REFERENCE_EXPIRED",
                        "Result expired; release it and acquire a new observation",
                    ));
                }
                record.items
            };
            if args.action == "release" {
                store.release(id)?;
                return Ok(json!({"id":id, "status":"released"}));
            }
            page(items, &args, id)
        }
        _ => Err(Failure::new(
            "INVALID_ARGUMENT",
            "Expected put, page or release",
        )),
    }
}
fn page(items: Vec<Value>, args: &ResultArgs, id: &str) -> Result<Value> {
    let limit = args.limit.unwrap_or(64);
    let budget = args.max_bytes.unwrap_or(16_384);
    if limit == 0
        || limit > 512
        || !(512..=65536).contains(&budget)
        || args
            .fields
            .as_ref()
            .is_some_and(|f| f.len() > 32 || f.iter().any(|s| s.len() > 128))
        || args.equals.as_ref().is_some_and(|e| e.len() > 16)
    {
        return Err(Failure::new(
            "INVALID_ARGUMENT",
            "Invalid quantity or byte budget",
        ));
    }
    let filtered: Vec<_> = items
        .into_iter()
        .filter(|item| {
            args.equals
                .as_ref()
                .is_none_or(|filter| filter.iter().all(|(k, v)| item.get(k) == Some(v)))
        })
        .collect();
    let total = filtered.len();
    let start = args.offset.min(total);
    let mut result = Vec::new();
    let mut next = start;
    for item in filtered.into_iter().skip(start).take(limit) {
        let item = if let Some(fields) = &args.fields {
            Value::Object(
                fields
                    .iter()
                    .filter_map(|k| item.get(k).map(|v| (k.clone(), v.clone())))
                    .collect(),
            )
        } else {
            item
        };
        result.push(item);
        let candidate = json!({"id":id,"items":result,"total":total,"nextOffset":next+1,"complete":next+1==total,"omitted":total-(next+1)});
        // Reserve envelope room for host sandbox facts added after transport.
        if serde_json::to_vec(&candidate)?.len() + 128 > budget {
            result.pop();
            if result.is_empty() {
                return Err(Failure::new(
                    "OUTPUT_LIMIT",
                    "One row exceeds page budget; select fewer fields or increase maxBytes",
                ));
            }
            break;
        }
        next += 1;
    }
    Ok(
        json!({"id":id,"items":result,"total":total,"nextOffset":next,"complete":next==total,"omitted":total-next}),
    )
}
