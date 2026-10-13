//! Handle-relative traversal. Never resolve user paths through a shell.
use crate::contract::{Failure, Kind, Result};
use cap_fs_ext::{DirExt, FollowSymlinks, OpenOptionsFollowExt};
use cap_std::fs::{Dir, Metadata, OpenOptions};
use sha2::{Digest, Sha256};
use std::{
    io::Read,
    path::{Component, Path},
};

pub const STORE: &str = ".dsh-ops";
const MAX_ENTRIES: u64 = 100_000;
const MAX_DEPTH: usize = 128;

pub fn relative(raw: &str) -> Result<String> {
    if raw.is_empty()
        || raw.len() > 4096
        || raw.contains(['\\', ':', '\0'])
        || raw
            .split('/')
            .any(|p| p.is_empty() || p == "." || p == "..")
    {
        return Err(Failure::new(
            "INVALID_ARGUMENT",
            "Use root-relative paths with forward slashes; no device paths or streams.",
        ));
    }
    let mut parts = Vec::new();
    for c in Path::new(raw).components() {
        match c {
            Component::Normal(n) => {
                let s = n
                    .to_str()
                    .ok_or_else(|| Failure::new("INVALID_ARGUMENT", "Non-UTF8 path"))?;
                let upper = s.split('.').next().unwrap_or("").to_ascii_uppercase();
                if s.ends_with(['.', ' '])
                    || s.contains(['*', '?', '<', '>', '|', '"'])
                    || matches!(upper.as_str(), "CON" | "PRN" | "AUX" | "NUL")
                    || (upper.len() == 4
                        && (upper.starts_with("COM") || upper.starts_with("LPT"))
                        && upper.ends_with(['1', '2', '3', '4', '5', '6', '7', '8', '9']))
                {
                    return Err(Failure::new(
                        "INVALID_ARGUMENT",
                        "Ambiguous or reserved path component",
                    ));
                }
                parts.push(s.to_owned());
            }
            _ => {
                return Err(Failure::new(
                    "POLICY_DENIED",
                    "Absolute paths, dot components and traversal are forbidden",
                ));
            }
        }
    }
    if parts.is_empty() || parts.iter().any(|p| p.eq_ignore_ascii_case(STORE)) {
        return Err(Failure::new(
            "POLICY_DENIED",
            "Root and audit storage are reserved",
        ));
    }
    Ok(parts.join("/"))
}
pub fn overlaps(a: &str, b: &str) -> bool {
    // Conservatively case-insensitive on every platform (also covers macOS defaults).
    let a = a.to_lowercase();
    let b = b.to_lowercase();
    a == b || a.starts_with(&(b.clone() + "/")) || b.starts_with(&(a + "/"))
}
pub fn parent(root: &Dir, path: &str) -> Result<(Dir, String)> {
    let mut dir = root.try_clone()?;
    let mut parts = path.split('/').peekable();
    while let Some(p) = parts.next() {
        if parts.peek().is_none() {
            return Ok((dir, p.into()));
        }
        reject_reparse(&dir.symlink_metadata(p)?)?;
        dir = dir.open_dir_nofollow(p)?;
    }
    Err(Failure::new("INVALID_ARGUMENT", "Empty path"))
}
fn reject_reparse(m: &Metadata) -> Result<()> {
    if m.file_type().is_symlink() {
        return Err(Failure::new(
            "POLICY_DENIED",
            "Linked ancestors are not traversed",
        ));
    }
    #[cfg(windows)]
    {
        use cap_std::fs::MetadataExt;
        if m.file_attributes() & 0x400 != 0 {
            return Err(Failure::new(
                "POLICY_DENIED",
                "Reparse points are not traversed",
            ));
        }
    }
    Ok(())
}
pub fn is_link(m: &Metadata) -> bool {
    if m.file_type().is_symlink() {
        return true;
    }
    #[cfg(windows)]
    {
        use cap_std::fs::MetadataExt;
        m.file_attributes() & 0x400 != 0
    }
    #[cfg(not(windows))]
    {
        false
    }
}
pub fn exists(root: &Dir, path: &str) -> Result<bool> {
    let (d, n) = parent(root, path)?;
    match d.symlink_metadata(n) {
        Ok(_) => Ok(true),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(e) => Err(e.into()),
    }
}
fn read_options() -> OpenOptions {
    let mut o = OpenOptions::new();
    o.read(true).follow(FollowSymlinks::No);
    o
}
#[derive(Default)]
pub struct Snapshot {
    pub revision: String,
    pub bytes: u64,
    pub entries: u64,
}
struct Scan {
    hash: Sha256,
    bytes: u64,
    entries: u64,
}
pub fn snapshot(root: &Dir, path: &str, kind: Kind) -> Result<Snapshot> {
    let (dir, name) = parent(root, path)?;
    let mut scan = Scan {
        hash: Sha256::new(),
        bytes: 0,
        entries: 0,
    };
    scan_node(&dir, &name, kind, &mut scan, 0)?;
    Ok(Snapshot {
        revision: format!("{:x}", scan.hash.finalize()),
        bytes: scan.bytes,
        entries: scan.entries,
    })
}
fn scan_node(dir: &Dir, name: &str, kind: Kind, s: &mut Scan, depth: usize) -> Result<()> {
    s.entries += 1;
    if s.entries > MAX_ENTRIES || depth > MAX_DEPTH {
        return Err(Failure::new("OUTPUT_LIMIT", "Traversal budget exceeded"));
    }
    let m = dir.symlink_metadata(name)?;
    if is_link(&m) {
        if kind != Kind::Remove {
            return Err(Failure::new(
                "POLICY_DENIED",
                "Copy/move of links or trees containing links is unsupported; remove only unlinks them",
            ));
        }
        s.hash.update(b"link\0");
        s.hash
            .update(dir.read_link_contents(name)?.to_string_lossy().as_bytes());
    } else if m.is_file() {
        s.hash.update(b"file\0");
        s.hash.update(m.len().to_le_bytes());
        let mut f = dir.open_with(name, &read_options())?;
        let mut buf = [0u8; 65536];
        loop {
            let n = f.read(&mut buf)?;
            if n == 0 {
                break;
            }
            s.hash.update(&buf[..n]);
            s.bytes += n as u64;
        }
    } else if m.is_dir() {
        reject_reparse(&m)?;
        if dir.canonicalize(name)? != Path::new(name) {
            return Err(Failure::new(
                "POLICY_DENIED",
                "Directory alias is unsupported",
            ));
        }
        let child = dir.open_dir_nofollow(name)?;
        // Linked Git worktrees carry an external gitdir; do not damage that relationship.
        if child.symlink_metadata(".git").is_ok_and(|m| !m.is_dir()) {
            return Err(Failure::new(
                "POLICY_DENIED",
                "Linked Git worktree requires its Git manager, not recursive filesystem operations",
            ));
        }
        s.hash.update(b"dir\0");
        let mut names = Vec::new();
        for entry in child.entries()? {
            let name = entry?
                .file_name()
                .into_string()
                .map_err(|_| Failure::new("POLICY_DENIED", "Non-UTF8 directory entry"))?;
            if names.len() >= MAX_ENTRIES as usize {
                return Err(Failure::new(
                    "OUTPUT_LIMIT",
                    "Directory entry budget exceeded",
                ));
            }
            if name.eq_ignore_ascii_case(STORE) {
                return Err(Failure::new(
                    "POLICY_DENIED",
                    "Nested audit store is protected",
                ));
            }
            names.push(name);
        }
        names.sort();
        for name in names {
            s.hash.update((name.len() as u64).to_le_bytes());
            s.hash.update(name.as_bytes());
            scan_node(&child, &name, kind, s, depth + 1)?;
        }
        s.hash.update(b"enddir\0");
    } else {
        return Err(Failure::new(
            "POLICY_DENIED",
            "Special filesystem objects are unsupported",
        ));
    }
    Ok(())
}
// No overwrites: files use CREATE_NEW; directories are created exclusively.
// A partial copy is intentionally retained and settled as unknown, never silently retried.
pub fn copy(root: &Dir, source: &str, dest: &str) -> Result<()> {
    let (sd, sn) = parent(root, source)?;
    let (dd, dn) = parent(root, dest)?;
    copy_node(&sd, &sn, &dd, &dn, 0, &mut 0)
}
fn copy_node(
    sd: &Dir,
    sn: &str,
    dd: &Dir,
    dn: &str,
    depth: usize,
    visited: &mut u64,
) -> Result<()> {
    *visited += 1;
    if *visited > MAX_ENTRIES || depth > MAX_DEPTH {
        return Err(Failure::new("OUTPUT_LIMIT", "Depth budget exceeded"));
    }
    let m = sd.symlink_metadata(sn)?;
    reject_reparse(&m)?;
    if m.is_file() {
        let mut source = sd.open_with(sn, &read_options())?;
        let mut options = OpenOptions::new();
        options
            .write(true)
            .create_new(true)
            .follow(FollowSymlinks::No);
        let mut target = dd.open_with(dn, &options)?;
        std::io::copy(&mut source, &mut target)?;
        target.set_permissions(source.metadata()?.permissions())?;
        target.sync_all()?;
    } else if m.is_dir() {
        dd.create_dir(dn)?;
        let source = sd.open_dir_nofollow(sn)?;
        let target = dd.open_dir_nofollow(dn)?;
        for entry in source.entries()? {
            let name = entry?
                .file_name()
                .into_string()
                .map_err(|_| Failure::new("POLICY_DENIED", "Non-UTF8 entry"))?;
            copy_node(&source, &name, &target, &name, depth + 1, visited)?;
        }
    } else {
        return Err(Failure::new("POLICY_DENIED", "Unsupported copy source"));
    }
    Ok(())
}
pub fn remove(root: &Dir, path: &str) -> Result<()> {
    let (dir, name) = parent(root, path)?;
    remove_node(&dir, &name, 0, &mut 0)
}
fn remove_node(dir: &Dir, name: &str, depth: usize, visited: &mut u64) -> Result<()> {
    *visited += 1;
    if *visited > MAX_ENTRIES || depth > MAX_DEPTH {
        return Err(Failure::new("OUTPUT_LIMIT", "Depth budget exceeded"));
    }
    let m = dir.symlink_metadata(name)?;
    if is_link(&m) {
        // Windows junctions are directory reparse points: RemoveDirectory unlinks only the entry.
        #[cfg(windows)]
        {
            use cap_std::fs::MetadataExt;
            if m.file_attributes() & 0x10 != 0 {
                dir.remove_dir(name)?;
                return Ok(());
            }
        }
        dir.remove_file(name)?;
    } else if m.is_dir() {
        let child = dir.open_dir_nofollow(name)?;
        for entry in child.entries()? {
            let n = entry?
                .file_name()
                .into_string()
                .map_err(|_| Failure::new("POLICY_DENIED", "Non-UTF8 entry"))?;
            remove_node(&child, &n, depth + 1, visited)?;
        }
        drop(child);
        dir.remove_dir(name)?;
    } else if m.is_file() {
        match dir.remove_file(name) {
            Ok(()) => (),
            #[cfg(windows)]
            Err(e)
                if e.kind() == std::io::ErrorKind::PermissionDenied
                    && m.permissions().readonly() =>
            {
                // File handles + no-follow avoid chmod of a link target. Do not chmod shared hardlinks.
                use cap_fs_ext::MetadataExt;
                let f = dir.open_with(name, &read_options())?;
                if f.metadata()?.nlink() != 1 {
                    return Err(Failure::new(
                        "POLICY_DENIED",
                        "Readonly hardlinked file cannot be safely changed",
                    ));
                }
                let mut p = f.metadata()?.permissions();
                p.set_readonly(false);
                f.set_permissions(p)?;
                dir.remove_file(name)?;
            }
            Err(e) => return Err(e.into()),
        }
    } else {
        return Err(Failure::new("POLICY_DENIED", "Special object"));
    }
    Ok(())
}
