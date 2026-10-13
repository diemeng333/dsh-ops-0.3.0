use flate2::read::GzDecoder;
use sha2::{Digest, Sha256};
use std::env;
use std::fs;
use std::io::{Cursor, Read};
use std::path::{Path, PathBuf};
use tar::Archive;

const RELEASE_TAG: &str = "chromium/7763";
const LOCAL_ARCHIVE_ENV: &str = "FASTCTX_PDFIUM_ARCHIVE";
const CACHE_DIRECTORY_ENV: &str = "FASTCTX_PDFIUM_CACHE_DIR";
const DISTRIBUTION_ENV: &str = "FASTCTX_DISTRIBUTION";
const MAX_ARCHIVE_BYTES: u64 = 64 * 1024 * 1024;
const MAX_LIBRARY_BYTES: u64 = 64 * 1024 * 1024;
const DOWNLOAD_ATTEMPTS: u32 = 6;

struct Artifact {
    asset: &'static str,
    archive_sha256: &'static str,
    member: &'static str,
    library_sha256: &'static str,
    filename: &'static str,
}

fn main() {
    println!("cargo:rerun-if-changed=build.rs");
    println!("cargo:rerun-if-changed=Cargo.toml");
    println!("cargo:rerun-if-changed=Cargo.lock");
    println!("cargo:rerun-if-changed=src");
    println!("cargo:rerun-if-env-changed={DISTRIBUTION_ENV}");
    println!("cargo:rerun-if-env-changed=CARGO_FEATURE_PDF");
    emit_build_id();
    if env::var_os("CARGO_FEATURE_PDF").is_none() {
        return;
    }
    println!("cargo:rerun-if-env-changed={LOCAL_ARCHIVE_ENV}");

    let target = env::var("TARGET").expect("Cargo did not provide TARGET");
    let target_env = format!(
        "{LOCAL_ARCHIVE_ENV}_{}",
        target.replace('-', "_").to_ascii_uppercase()
    );
    println!("cargo:rerun-if-env-changed={target_env}");

    let artifact = artifact_for_target(&target).unwrap_or_else(|| {
        panic!(
            "bundled PDF support does not have a pinned Pdfium artifact for target {target}; supported targets are Windows x64, Windows arm64, Linux x64, macOS x64, and macOS arm64"
        )
    });
    let archive_bytes = load_archive(&artifact, &target_env);
    verify_sha256(
        &archive_bytes,
        artifact.archive_sha256,
        "Pdfium release archive",
    );
    let library_bytes = extract_member(&archive_bytes, artifact.member);
    verify_sha256(
        &library_bytes,
        artifact.library_sha256,
        "Pdfium dynamic library",
    );

    let out_dir = PathBuf::from(env::var_os("OUT_DIR").expect("Cargo did not provide OUT_DIR"));
    let embedded_dir = out_dir.join("bundled-pdfium");
    fs::create_dir_all(&embedded_dir).expect("failed to create Pdfium build output directory");
    let library_path = embedded_dir.join(artifact.filename);
    fs::write(&library_path, library_bytes).expect("failed to write extracted Pdfium library");
    write_generated_module(&out_dir, &library_path, &artifact);
}

fn emit_build_id() {
    let mut files = vec![
        PathBuf::from("Cargo.toml"),
        PathBuf::from("Cargo.lock"),
        PathBuf::from("build.rs"),
    ];
    collect_source_files(Path::new("src"), &mut files);
    files.sort();
    let mut hasher = Sha256::new();
    for path in files {
        hasher.update(path.to_string_lossy().as_bytes());
        hasher.update([0]);
        hasher.update(fs::read(&path).unwrap_or_else(|error| {
            panic!("failed to hash {} for build id: {error}", path.display())
        }));
        hasher.update([0xff]);
    }
    for name in [
        "CARGO_PKG_VERSION",
        "TARGET",
        "PROFILE",
        "CARGO_FEATURE_PDF",
        DISTRIBUTION_ENV,
    ] {
        hasher.update(name.as_bytes());
        hasher.update(*b"=");
        if let Some(value) = env::var_os(name) {
            hasher.update(value.to_string_lossy().as_bytes());
        }
        hasher.update([0]);
    }
    let build_id = hex::encode(hasher.finalize());
    println!("cargo:rustc-env=FASTCTX_BUILD_ID={}", &build_id[..16]);
}

fn collect_source_files(directory: &Path, output: &mut Vec<PathBuf>) {
    let mut entries = fs::read_dir(directory)
        .unwrap_or_else(|error| {
            panic!(
                "failed to enumerate {} for build id: {error}",
                directory.display()
            )
        })
        .map(|entry| entry.expect("failed to enumerate a source entry").path())
        .collect::<Vec<_>>();
    entries.sort();
    for path in entries {
        if path.is_dir() {
            collect_source_files(&path, output);
        } else if path.extension().is_some_and(|extension| extension == "rs") {
            output.push(path);
        }
    }
}

fn artifact_for_target(target: &str) -> Option<Artifact> {
    let artifact = match target {
        "x86_64-pc-windows-msvc" | "x86_64-pc-windows-gnu" => Artifact {
            asset: "pdfium-win-x64.tgz",
            archive_sha256: "45c4cc5d052ef8ec6380b946b548a76100f4675e38362000a4c732e16d5e8eda",
            member: "bin/pdfium.dll",
            library_sha256: "a63949dc46a7314bba619ac6cc1b3849627e137f542ae31b2b36b302841f77ae",
            filename: "pdfium.dll",
        },
        "aarch64-pc-windows-msvc" => Artifact {
            asset: "pdfium-win-arm64.tgz",
            archive_sha256: "e99570d74211a88d41589feb8861ef9b40d78c8d26825270ad4fb7a9a1d02f6d",
            member: "bin/pdfium.dll",
            library_sha256: "682ee648af5629c1194bb3649e67252d162bdab06e00cded3e2ebbe88be7bf49",
            filename: "pdfium.dll",
        },
        "x86_64-unknown-linux-gnu" => Artifact {
            asset: "pdfium-linux-x64.tgz",
            archive_sha256: "e3f0c66b2daad710cb6c8edd4a8c45c8902995e359dc0775917fc16e2e56349d",
            member: "lib/libpdfium.so",
            library_sha256: "9167f6d9190f217fab5bfb864620108e280c124b7f7762cc4ef66e1078e0ec62",
            filename: "libpdfium.so",
        },
        "x86_64-apple-darwin" => Artifact {
            asset: "pdfium-mac-x64.tgz",
            archive_sha256: "f455e0868ef7e5174a315de8789ee2b7a5544638d0ac7a3312ea7b68ebbc99cb",
            member: "lib/libpdfium.dylib",
            library_sha256: "b67d8bc289bf9916f697add53b163730ff22243ea896e97f942e09cb634e8a14",
            filename: "libpdfium.dylib",
        },
        "aarch64-apple-darwin" => Artifact {
            asset: "pdfium-mac-arm64.tgz",
            archive_sha256: "9acf49e46c68992cd40810e88264b1ad171805d02fd41c4cca336aad6653b333",
            member: "lib/libpdfium.dylib",
            library_sha256: "0501a43035c44ccd498d77c1bf7fb8aa88facdd0963d423f51cfea2d4d46f52b",
            filename: "libpdfium.dylib",
        },
        _ => return None,
    };
    Some(artifact)
}

/// Resolves the pinned archive from the cheapest source that can supply it: an
/// explicit local path, then the on-disk cache, then the release CDN.
///
/// Cargo gives every feature-and-profile combination its own build script run, and CI
/// visits several of them per job, so without a cache one job fetches the same pinned
/// bytes once per combination - measured at four over a subset of this repository's own
/// sequence. Every one of those is an independent chance to land in a release CDN
/// outage, which is how a green build turns red for no local reason.
fn load_archive(artifact: &Artifact, target_env: &str) -> Vec<u8> {
    if let Some(path) = env::var_os(target_env).or_else(|| env::var_os(LOCAL_ARCHIVE_ENV)) {
        println!("cargo:rerun-if-changed={}", Path::new(&path).display());
        let file = fs::File::open(&path).unwrap_or_else(|error| {
            panic!(
                "failed to read local Pdfium archive {}: {error}",
                Path::new(&path).display()
            )
        });
        return read_limited(file, MAX_ARCHIVE_BYTES, "local Pdfium archive");
    }

    let cached = cache_path(artifact);
    if let Some(bytes) = cached
        .as_deref()
        .and_then(|path| read_cached_archive(path, artifact))
    {
        return bytes;
    }

    let url = format!(
        "https://github.com/bblanchon/pdfium-binaries/releases/download/{RELEASE_TAG}/{}",
        artifact.asset
    );
    let bytes = read_limited(
        download(&url).into_reader(),
        MAX_ARCHIVE_BYTES,
        "downloaded Pdfium archive",
    );
    if let Some(path) = cached.as_deref() {
        store_cached_archive(path, &bytes);
    }
    bytes
}

/// Names the cache entry after the digest the build already pins, so an entry can
/// only ever be the exact bytes this build wants. A damaged or half-written file is
/// a miss rather than a silent substitution, and `main` verifies the result whatever
/// source produced it.
fn cache_path(artifact: &Artifact) -> Option<PathBuf> {
    let directory = cache_directory()?;
    Some(directory.join(format!("{}-{}", artifact.archive_sha256, artifact.asset)))
}

fn cache_directory() -> Option<PathBuf> {
    // Deliberately not declared with `cargo:rerun-if-env-changed`: the pinned digest
    // makes the produced bytes independent of where they were found, so tracking this
    // variable would buy nothing but extra build script runs - the very cost the cache
    // exists to remove. An empty value opts a hermetic build out entirely.
    if let Some(explicit) = env::var_os(CACHE_DIRECTORY_ENV) {
        if explicit.is_empty() {
            return None;
        }
        return Some(PathBuf::from(explicit));
    }
    default_cache_root().map(|root| root.join("fastctx").join("pdfium"))
}

/// `cfg!` rather than `#[cfg]` keeps every branch compiled on every host. This
/// repository has a single local build gate, so platform-gated code that exists only
/// on the other targets is precisely what it cannot check before CI.
fn default_cache_root() -> Option<PathBuf> {
    if cfg!(windows) {
        return env::var_os("LOCALAPPDATA").map(PathBuf::from);
    }
    if cfg!(target_os = "macos") {
        return env::var_os("HOME").map(|home| PathBuf::from(home).join("Library/Caches"));
    }
    if let Some(directory) = env::var_os("XDG_CACHE_HOME") {
        return Some(PathBuf::from(directory));
    }
    env::var_os("HOME").map(|home| PathBuf::from(home).join(".cache"))
}

fn read_cached_archive(path: &Path, artifact: &Artifact) -> Option<Vec<u8>> {
    let file = fs::File::open(path).ok()?;
    let bytes = try_read_limited(file, MAX_ARCHIVE_BYTES).ok()?;
    if hex::encode(Sha256::digest(&bytes)) == artifact.archive_sha256 {
        return Some(bytes);
    }
    // An entry that no longer matches the digest it is named after was damaged after
    // it was written. Say so - a cache quietly missing forever is how a workaround
    // becomes permanent - then fall back to the network instead of failing a build
    // over storage this crate owns and can rebuild.
    println!(
        "cargo:warning=cached Pdfium archive {} no longer matches its pinned digest; refetching",
        path.display()
    );
    let _ = fs::remove_file(path);
    None
}

/// Best effort by design: a build that cannot populate the cache is slower, never
/// wrong, so an unwritable directory leaves the download path carrying the build.
fn store_cached_archive(path: &Path, bytes: &[u8]) {
    let (Some(directory), Some(name)) = (path.parent(), path.file_name().and_then(|n| n.to_str()))
    else {
        return;
    };
    if fs::create_dir_all(directory).is_err() {
        return;
    }
    // Publish through a rename so a cargo invocation reading the same entry in
    // parallel never observes a partial archive under the final name.
    let staging = directory.join(format!("{name}.{}.partial", std::process::id()));
    if fs::write(&staging, bytes).is_ok() && fs::rename(&staging, path).is_ok() {
        return;
    }
    let _ = fs::remove_file(&staging);
}

/// Fetches the pinned release asset, retrying only the failures a later attempt can
/// clear. Retrying cannot widen what the build accepts: the bytes are still checked
/// against the pinned digest afterwards. The attempt count spans roughly a minute of
/// backoff because the release CDN goes down for stretches longer than a handful of
/// seconds; widening a wait like this one only delays the report of a real outage,
/// while keeping it tight reports a healthy build as broken.
fn download(url: &str) -> ureq::Response {
    let mut attempt = 1;
    loop {
        let error = match ureq::get(url)
            .timeout(std::time::Duration::from_secs(150))
            .call()
        {
            Ok(response) => return response,
            Err(error) => error,
        };
        if attempt >= DOWNLOAD_ATTEMPTS || !is_retryable(&error) {
            panic!(
                "failed to download pinned Pdfium archive from {url}: {error}. For an offline build, set {LOCAL_ARCHIVE_ENV} to the matching archive path"
            );
        }
        println!("cargo:warning=attempt {attempt} to download {url} failed ({error}); retrying");
        std::thread::sleep(std::time::Duration::from_secs(2u64.pow(attempt)));
        attempt += 1;
    }
}

/// An absent or forbidden asset means the pinned release tag is wrong, which fails
/// identically however often it is asked; only transport faults and server-side
/// failures are worth repeating.
fn is_retryable(error: &ureq::Error) -> bool {
    match error {
        ureq::Error::Status(code, _) => *code == 408 || *code == 429 || *code >= 500,
        ureq::Error::Transport(_) => true,
    }
}

fn read_limited(reader: impl Read, limit: u64, label: &str) -> Vec<u8> {
    try_read_limited(reader, limit).unwrap_or_else(|error| panic!("{label}: {error}"))
}

/// The fallible half exists for the cache, where an unreadable or oversized entry has
/// a recovery - refetch - that a missing download does not.
fn try_read_limited(mut reader: impl Read, limit: u64) -> Result<Vec<u8>, String> {
    let mut bytes = Vec::new();
    reader
        .by_ref()
        .take(limit + 1)
        .read_to_end(&mut bytes)
        .map_err(|error| format!("read failed: {error}"))?;
    if bytes.len() as u64 > limit {
        return Err(format!(
            "exceeds the {} MiB build safety limit",
            limit / (1024 * 1024)
        ));
    }
    Ok(bytes)
}

fn verify_sha256(bytes: &[u8], expected: &str, label: &str) {
    let actual = hex::encode(Sha256::digest(bytes));
    assert_eq!(
        actual, expected,
        "{label} SHA-256 mismatch; expected {expected}, got {actual}"
    );
}

fn extract_member(archive_bytes: &[u8], expected_member: &str) -> Vec<u8> {
    let decoder = GzDecoder::new(Cursor::new(archive_bytes));
    let mut archive = Archive::new(decoder);
    let mut found = None;
    for entry in archive
        .entries()
        .expect("failed to read Pdfium tar archive")
    {
        let mut entry = entry.expect("failed to read an entry from Pdfium tar archive");
        let path = entry
            .path()
            .expect("Pdfium archive contains an invalid path")
            .into_owned();
        assert!(
            !path.is_absolute()
                && !path
                    .components()
                    .any(|part| matches!(part, std::path::Component::ParentDir)),
            "Pdfium archive contains an unsafe path: {}",
            path.display()
        );
        if path == Path::new(expected_member) {
            assert!(
                found.is_none(),
                "Pdfium archive contains the library more than once"
            );
            assert!(
                entry.size() <= MAX_LIBRARY_BYTES,
                "Pdfium dynamic library exceeds the {} MiB build safety limit",
                MAX_LIBRARY_BYTES / (1024 * 1024)
            );
            let mut bytes = Vec::new();
            entry
                .by_ref()
                .take(MAX_LIBRARY_BYTES + 1)
                .read_to_end(&mut bytes)
                .expect("failed to extract Pdfium dynamic library");
            assert!(
                bytes.len() as u64 <= MAX_LIBRARY_BYTES,
                "Pdfium dynamic library exceeds the {} MiB build safety limit",
                MAX_LIBRARY_BYTES / (1024 * 1024)
            );
            found = Some(bytes);
        }
    }
    found.unwrap_or_else(|| panic!("Pdfium archive did not contain {expected_member}"))
}

fn write_generated_module(out_dir: &Path, library_path: &Path, artifact: &Artifact) {
    let path_literal = format!("{:?}", library_path.to_string_lossy());
    let source = format!(
        "pub const PDFIUM_BYTES: &[u8] = include_bytes!({path_literal});\n\
         pub const PDFIUM_FILENAME: &str = {:?};\n\
         pub const PDFIUM_SHA256: &str = {:?};\n\
         pub const PDFIUM_RELEASE_TAG: &str = {:?};\n",
        artifact.filename, artifact.library_sha256, RELEASE_TAG
    );
    fs::write(out_dir.join("pdfium_embedded.rs"), source)
        .expect("failed to generate Pdfium embedding module");
}
