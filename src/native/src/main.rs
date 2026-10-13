#![forbid(unsafe_code)]
use dsh_ops_core::{
    contract::{Failure, Request},
    dispatch,
};
use serde_json::json;
use std::io::{Read, Write};
fn main() {
    if std::env::args().any(|a| a == "--version") {
        println!("dsh-ops-worker {}", env!("CARGO_PKG_VERSION"));
        return;
    }
    let value = (|| {
        let mut bytes = Vec::new();
        std::io::stdin()
            .take(2 * 1024 * 1024 + 1)
            .read_to_end(&mut bytes)
            .map_err(Failure::from)?;
        if bytes.len() > 2 * 1024 * 1024 {
            return Err(Failure::new("OUTPUT_LIMIT", "Request exceeds 2 MiB"));
        }
        let request: Request = serde_json::from_slice(&bytes)?;
        dispatch(request)
    })();
    let output = match value {
        Ok(v) => v,
        Err(e) => json!({ "status": "error", "error": e }),
    };
    // stdout is a single bounded canonical JSON result. No execution facts depend on presentation.
    let encoded = serde_json::to_vec(&output)
        .unwrap_or_else(|_| b"{\"status\":\"error\",\"code\":\"OUTPUT_LIMIT\"}".to_vec());
    let mut stdout = std::io::stdout().lock();
    let _ = stdout.write_all(&encoded);
    let _ = stdout.write_all(b"\n");
}
