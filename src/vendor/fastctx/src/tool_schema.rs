//! Wire-format normalization for the tool input schemas FastCtx publishes.
//!
//! # Why this exists
//!
//! MCP lets a server publish any JSON Schema, and SEP-2106 widened that further.
//! The LLM APIs that ultimately consume a tool declaration do not: each accepts a
//! narrow, and differently narrow, subset. A declaration one of them rejects is not
//! degraded but fatal — the provider answers 400 for the whole request, so every
//! FastCtx tool disappears from that turn rather than just the offending parameter.
//!
//! Hosts do not absorb the difference for us. Codex forwards `$ref` and the
//! composition keywords untouched, and rewrites every local `$ref` to `{}` once a
//! tool schema crosses its compaction budget, which silently erases the accepted
//! values of an enum parameter. Other hosts each grew their own partial lowering.
//! FastCtx therefore publishes the intersection of the provider subsets instead of
//! the union of what MCP permits.
//!
//! # The published subset
//!
//! Every node carries a single scalar `type`. No published schema contains `$ref`,
//! `$defs`, `oneOf`, `anyOf`, `allOf`, `const`, `$schema`, `additionalProperties`,
//! `format`, or a `"null"` type. Only these keywords appear: `type`, `description`,
//! `properties`, `required`, `items`, `enum`, `default`, `minimum`, `maximum`,
//! `minItems`, `maxItems`.
//!
//! This is a published contract, not a local style choice. It is enforced by
//! `server_contract::published_tool_schemas_stay_inside_the_portable_subset`, which
//! walks every published tool instead of a named list of parameters, so neither a
//! new tool nor a new parameter type can reintroduce a rejected construct unnoticed.
//! Widening the subset means answering, for each provider, why the addition is safe.
//!
//! # Deserialization is untouched
//!
//! Normalization rewrites only what the model is told. Serde still parses the
//! original Rust types, so a parameter may accept more than its schema advertises.
//! That direction is safe: every input the schema describes is still accepted.

use serde_json::{Map, Value};

/// Keys removed from every node.
///
/// - `$schema` is metadata no consumer needs, and hosts strip it anyway.
/// - `additionalProperties` does not exist in the Gemini API `Schema` type, where an
///   unrecognized key is an `Unknown name` 400. Removing it costs no runtime
///   strictness: `serde(deny_unknown_fields)` still rejects unknown input at call time.
/// - `format` carries our numeric widths (`uint`, `uint64`, `int64`), which sit
///   outside every provider's accepted format set while `minimum`/`maximum` already
///   express the same bound.
const STRIPPED_KEYS: [&str; 3] = ["$schema", "additionalProperties", "format"];

/// Bounds `$ref` inlining so a future self-referential type cannot spin here.
/// Exceeding it leaves the `$ref` in place, which the published-shape guard reports.
const MAX_INLINE_DEPTH: usize = 32;

/// Rewrites one tool's input schema into the portable subset described above.
pub(crate) fn normalize_published_schema(schema: &Map<String, Value>) -> Map<String, Value> {
    let definitions = schema
        .get("$defs")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    let mut root = schema.clone();
    root.remove("$defs");
    match normalize_node(Value::Object(root), &definitions, 0) {
        Value::Object(normalized) => normalized,
        // A tool schema is an object by construction; anything else means the router
        // handed us something we do not publish, so pass the original through
        // untouched rather than invent a shape.
        _ => schema.clone(),
    }
}

fn normalize_node(node: Value, definitions: &Map<String, Value>, depth: usize) -> Value {
    let Value::Object(mut map) = node else {
        return node;
    };
    for key in STRIPPED_KEYS {
        map.remove(key);
    }
    if let Some(inlined) = inlined_reference(&map, definitions, depth) {
        map = inlined;
    }
    collapse_nullable_union(&mut map, definitions, depth);
    collapse_const_variants(&mut map);
    collapse_nullable_type(&mut map);

    if let Some(Value::Object(properties)) = map.remove("properties") {
        let normalized = properties
            .into_iter()
            .map(|(name, value)| (name, normalize_node(value, definitions, depth + 1)))
            .collect();
        map.insert("properties".to_string(), Value::Object(normalized));
    }
    if let Some(items) = map.remove("items") {
        map.insert(
            "items".to_string(),
            normalize_node(items, definitions, depth + 1),
        );
    }
    Value::Object(map)
}

/// Replaces a local `$ref` with the definition body it points at.
///
/// The referring node's own keys win, so a parameter's `description` outranks the
/// shared description on the type it names. Only `#/$defs/<name>` is resolved:
/// SEP-2106 requires that a remote `$ref` never be dereferenced.
fn inlined_reference(
    map: &Map<String, Value>,
    definitions: &Map<String, Value>,
    depth: usize,
) -> Option<Map<String, Value>> {
    if depth >= MAX_INLINE_DEPTH {
        return None;
    }
    let name = map.get("$ref")?.as_str()?.strip_prefix("#/$defs/")?;
    let Value::Object(mut merged) =
        normalize_node(definitions.get(name)?.clone(), definitions, depth + 1)
    else {
        return None;
    };
    for (key, value) in map {
        if key != "$ref" {
            merged.insert(key.clone(), value.clone());
        }
    }
    Some(merged)
}

/// Collapses the `Option<T>` shape `anyOf: [T, {"type": "null"}]` down to `T`.
///
/// The `required` list already says which parameters may be omitted, so the union
/// spells optionality a second time in the one form no provider subset accepts. A
/// union with more than one non-null branch is left intact on purpose: guessing a
/// branch would silently narrow what the model may send, so the published-shape
/// guard fails instead and the choice gets made at the Rust type.
fn collapse_nullable_union(
    map: &mut Map<String, Value>,
    definitions: &Map<String, Value>,
    depth: usize,
) {
    let Some(Value::Array(branches)) = map.get("anyOf") else {
        return;
    };
    let mut kept: Vec<Value> = branches
        .iter()
        .map(|branch| normalize_node(branch.clone(), definitions, depth + 1))
        .filter(|branch| branch.get("type").and_then(Value::as_str) != Some("null"))
        .collect();
    if kept.len() != 1 {
        return;
    }
    let Value::Object(branch) = kept.remove(0) else {
        return;
    };
    map.remove("anyOf");
    for (key, value) in branch {
        map.entry(key).or_insert(value);
    }
}

/// Rewrites the `oneOf` of `const` variants schemars derives for a fieldless enum
/// into `type: "string"` with `enum`.
///
/// No provider subset accepts `oneOf` or `const`; all of them accept a string enum.
/// The per-variant doc comments are dropped along with the `oneOf`, so every such
/// parameter states its accepted values in its own `description`.
fn collapse_const_variants(map: &mut Map<String, Value>) {
    let Some(Value::Array(variants)) = map.get("oneOf") else {
        return;
    };
    let mut values = Vec::with_capacity(variants.len());
    for variant in variants {
        match variant.get("const") {
            Some(Value::String(value)) => values.push(Value::String(value.clone())),
            _ => return,
        }
    }
    if values.is_empty() {
        return;
    }
    map.remove("oneOf");
    map.insert("type".to_string(), Value::String("string".to_string()));
    map.insert("enum".to_string(), Value::Array(values));
}

/// Rewrites `type: ["string", "null"]` as `type: "string"`.
///
/// Gemini's schema type is a single scalar rather than a list, so a type array is
/// rejected outright; `required` already carries which parameters are optional.
fn collapse_nullable_type(map: &mut Map<String, Value>) {
    let Some(Value::Array(members)) = map.get("type") else {
        return;
    };
    let mut kept: Vec<Value> = members
        .iter()
        .filter(|member| member.as_str() != Some("null"))
        .cloned()
        .collect();
    if kept.len() != 1 {
        return;
    }
    map.insert("type".to_string(), kept.remove(0));
}
