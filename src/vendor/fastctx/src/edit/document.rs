// Modified by dsh-ops (https://github.com/T-Auto/dsh-ops): dropped the removed transaction parameter that only the deleted self-updater passed as true.
//! Byte-preserving editable text snapshots, line anchors, CAS, and atomic commit.

use crate::control::transaction;
use crate::encoding::{EncodingDecision, ValidatedFileEncoding};
use crate::paths::{display_path, io_error_message, missing_file_message, parse_input_path};
use sha2::{Digest, Sha256};
use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};

#[cfg(test)]
type BeforeCommitHook = Box<dyn FnOnce(&Path)>;

#[cfg(test)]
thread_local! {
    static BEFORE_COMMIT: std::cell::RefCell<Option<BeforeCommitHook>> =
        std::cell::RefCell::new(None);
}

const MIB: u64 = 1024 * 1024;
const OFFSET_CHUNK_BYTES: usize = 64 * 1024;

/// Newline style used for every boundary introduced by an edit.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum EolStyle {
    Lf,
    Crlf,
}

impl EolStyle {
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            Self::Lf => "\n",
            Self::Crlf => "\r\n",
        }
    }
}

struct LogicalView {
    logical: String,
    source_line_endings: SourceLineEndings,
    eol: EolStyle,
}

#[derive(Clone, Debug, Default)]
struct SourceLineEndings {
    crlf_bits: Vec<u64>,
    len: usize,
}

impl SourceLineEndings {
    fn push(&mut self, is_crlf: bool) {
        let index = self.len;
        if index.is_multiple_of(64) {
            self.crlf_bits.push(0);
        }
        if is_crlf {
            self.crlf_bits[index / 64] |= 1_u64 << (index % 64);
        }
        self.len = self.len.saturating_add(1);
    }

    fn is_crlf(&self, index: usize) -> bool {
        debug_assert!(index < self.len);
        self.crlf_bits
            .get(index / 64)
            .is_some_and(|bits| bits & (1_u64 << (index % 64)) != 0)
    }
}

/// Frozen source bytes and every derived view needed for safe line edits.
#[derive(Clone, Debug)]
pub(crate) struct TextDocument {
    requested_path: PathBuf,
    target_path: PathBuf,
    raw: Vec<u8>,
    validated: ValidatedFileEncoding,
    logical: String,
    source_line_endings: SourceLineEndings,
    eol: EolStyle,
    trailing_newline: bool,
    unix_mode: Option<u32>,
}

impl TextDocument {
    /// Opens one absolute regular-file target, following symlinks while preserving the link itself.
    pub(crate) fn open(
        file_path: &str,
        encoding: Option<&str>,
        max_file_size_mib: u64,
    ) -> Result<Self, String> {
        let requested_path = parse_input_path(file_path);
        if !requested_path.is_absolute() {
            return Err(missing_file_message(file_path));
        }
        match fs::symlink_metadata(&requested_path) {
            Ok(_) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                return Err(missing_file_message(file_path));
            }
            Err(error) => return Err(io_error_message(&requested_path, &error)),
        }
        let target_path = resolve_target(&requested_path)?;
        reject_hard_link(&target_path)?;
        let metadata =
            fs::metadata(&target_path).map_err(|error| io_error_message(&target_path, &error))?;
        if !metadata.is_file() {
            return Err(format!(
                "Cannot edit non-regular file: {}. Only regular files are supported.",
                display_path(&requested_path)
            ));
        }
        let maximum_bytes = max_file_size_mib.saturating_mul(MIB);
        let raw = match read_limited(&target_path, maximum_bytes)? {
            LimitedRead::Bytes(raw) => raw,
            LimitedRead::TooLarge(actual_bytes) => {
                return Err(file_too_large_message(
                    &requested_path,
                    actual_bytes,
                    max_file_size_mib,
                ));
            }
        };
        let validated = match crate::encoding::validate_file_encoding(&target_path, encoding)
            .map_err(|error| io_error_message(&target_path, &error))?
        {
            EncodingDecision::Text(validated) => validated,
            EncodingDecision::Binary => {
                return Err(format!(
                    "Cannot read binary file as text: {}. Use view=\"hex\" to inspect its raw bytes.",
                    display_path(&requested_path)
                ));
            }
            EncodingDecision::Rejected(rejection) => {
                return Err(rejection.message(&display_path(&requested_path)));
            }
        };
        if !file_matches_bytes(&target_path, &raw)? {
            return Err(concurrent_message(&requested_path));
        }
        let editable = validated.decode_editable_snapshot(&raw).map_err(|reason| {
            format!(
                "Cannot safely edit {}: {reason}. Convert the file to UTF-8 externally and retry.",
                display_path(&requested_path)
            )
        })?;
        let LogicalView {
            logical,
            source_line_endings,
            eol,
        } = logical_view(editable);
        let trailing_newline = logical.ends_with('\n');
        let unix_mode = transaction::existing_unix_mode(&target_path);
        Ok(Self {
            requested_path,
            target_path,
            raw,
            validated,
            logical,
            source_line_endings,
            eol,
            trailing_newline,
            unix_mode,
        })
    }

    pub(crate) fn display_path(&self) -> String {
        display_path(&self.requested_path)
    }

    pub(crate) fn target_path(&self) -> &Path {
        &self.target_path
    }

    pub(crate) fn original_bytes(&self) -> &[u8] {
        &self.raw
    }

    pub(crate) fn logical_text(&self) -> &str {
        &self.logical
    }

    pub(crate) fn trailing_newline(&self) -> bool {
        self.trailing_newline
    }

    pub(crate) fn encoding_label(&self) -> &'static str {
        self.validated.encoding_label()
    }

    pub(crate) fn revision(&self) -> String {
        hex::encode(Sha256::digest(&self.raw))
    }

    /// Commits one frozen snapshot if and only if the target still equals B0.
    pub(crate) fn commit(mut self, new_bytes: &[u8]) -> Result<(), String> {
        #[cfg(test)]
        run_before_commit_hook(&self.target_path);
        drop(std::mem::take(&mut self.logical));
        if !file_matches_bytes(&self.target_path, &self.raw)? {
            return Err(concurrent_message(&self.requested_path));
        }
        reject_hard_link(&self.target_path)?;
        drop(std::mem::take(&mut self.raw));
        transaction::atomic_replace(&self.target_path, new_bytes, self.unix_mode)
    }

    pub(crate) fn encode_for_target(&self, logical_text: &str) -> Result<Vec<u8>, String> {
        let text = logical_text.replace('\n', self.eol.as_str());
        self.validated.encode_fragment(&text).ok_or_else(|| {
            format!(
                "Cannot write {}: the replacement text cannot be encoded as {}. Convert the file to UTF-8 externally or use replacement text representable in that encoding.",
                self.display_path(),
                self.encoding_label()
            )
        })
    }

    pub(crate) fn raw_offset_cursor(&self) -> Result<RawOffsetCursor<'_>, String> {
        let carriage_return_bytes = self.validated.encode_fragment("\r").ok_or_else(|| {
            format!(
                "Internal edit failure: source encoding {} cannot reproduce line endings.",
                self.encoding_label()
            )
        })?;
        Ok(RawOffsetCursor {
            document: self,
            logical_offset: 0,
            raw_offset: self.validated.editable_raw_start(),
            newline_index: 0,
            carriage_return_bytes: carriage_return_bytes.len(),
        })
    }
}

pub(crate) struct RawOffsetCursor<'a> {
    document: &'a TextDocument,
    logical_offset: usize,
    raw_offset: usize,
    newline_index: usize,
    carriage_return_bytes: usize,
}

impl RawOffsetCursor<'_> {
    /// Advances monotonically through logical text while reconstructing original raw offsets.
    pub(crate) fn advance_to(&mut self, target: usize) -> Result<usize, String> {
        let logical = self.document.logical_text();
        if target < self.logical_offset
            || target > logical.len()
            || !logical.is_char_boundary(target)
        {
            return Err(
                "Internal edit failure: a logical range did not end on a character boundary."
                    .to_string(),
            );
        }
        while self.logical_offset < target {
            let end = next_char_boundary(logical, self.logical_offset, target, OFFSET_CHUNK_BYTES);
            let chunk = &logical[self.logical_offset..end];
            let encoded = self
                .document
                .validated
                .encode_fragment(chunk)
                .ok_or_else(|| {
                    format!(
                        "Internal edit failure: source encoding {} cannot reproduce unchanged text.",
                        self.document.encoding_label()
                    )
                })?;
            self.raw_offset = self.raw_offset.saturating_add(encoded.len());
            for _ in chunk.bytes().filter(|byte| *byte == b'\n') {
                if self
                    .document
                    .source_line_endings
                    .is_crlf(self.newline_index)
                {
                    self.raw_offset = self.raw_offset.saturating_add(self.carriage_return_bytes);
                }
                self.newline_index = self.newline_index.saturating_add(1);
            }
            self.logical_offset = end;
        }
        Ok(self.raw_offset)
    }
}

#[cfg(test)]
pub(crate) fn set_before_commit_hook(hook: impl FnOnce(&Path) + 'static) {
    BEFORE_COMMIT.with(|slot| *slot.borrow_mut() = Some(Box::new(hook)));
}

#[cfg(test)]
fn run_before_commit_hook(path: &Path) {
    BEFORE_COMMIT.with(|hook| {
        if let Some(hook) = hook.borrow_mut().take() {
            hook(path);
        }
    });
}

fn logical_view(text: String) -> LogicalView {
    let mut bytes = text.into_bytes();
    let mut source_line_endings = SourceLineEndings::default();
    let mut crlf = 0_usize;
    let mut lf = 0_usize;
    let mut read = 0_usize;
    let mut write = 0_usize;
    while read < bytes.len() {
        if bytes[read] == b'\r' && bytes.get(read + 1) == Some(&b'\n') {
            bytes[write] = b'\n';
            write += 1;
            read += 2;
            source_line_endings.push(true);
            crlf += 1;
            continue;
        }
        let byte = bytes[read];
        bytes[write] = byte;
        write += 1;
        read += 1;
        if byte == b'\n' {
            source_line_endings.push(false);
            lf += 1;
        }
    }
    bytes.truncate(write);
    let logical = String::from_utf8(bytes).expect("removing ASCII CR bytes preserves UTF-8");
    let eol = if crlf > lf {
        EolStyle::Crlf
    } else {
        EolStyle::Lf
    };
    LogicalView {
        logical,
        source_line_endings,
        eol,
    }
}

fn next_char_boundary(text: &str, start: usize, target: usize, maximum_bytes: usize) -> usize {
    let mut end = start.saturating_add(maximum_bytes).min(target);
    while end > start && !text.is_char_boundary(end) {
        end -= 1;
    }
    if end == start { target } else { end }
}

enum LimitedRead {
    Bytes(Vec<u8>),
    TooLarge(u64),
}

fn read_limited(path: &Path, maximum_bytes: u64) -> Result<LimitedRead, String> {
    let mut file = fs::File::open(path).map_err(|error| io_error_message(path, &error))?;
    let initial_len = file
        .metadata()
        .map_err(|error| io_error_message(path, &error))?
        .len();
    if initial_len > maximum_bytes {
        return Ok(LimitedRead::TooLarge(initial_len));
    }
    let capacity = usize::try_from(initial_len).unwrap_or(usize::MAX);
    let mut bytes = Vec::with_capacity(capacity);
    let mut buffer = [0_u8; OFFSET_CHUNK_BYTES];
    loop {
        let count = file
            .read(&mut buffer)
            .map_err(|error| io_error_message(path, &error))?;
        if count == 0 {
            return Ok(LimitedRead::Bytes(bytes));
        }
        let projected = bytes.len().saturating_add(count);
        if u64::try_from(projected).unwrap_or(u64::MAX) > maximum_bytes {
            let observed = file
                .metadata()
                .map(|metadata| metadata.len())
                .unwrap_or(maximum_bytes.saturating_add(1))
                .max(u64::try_from(projected).unwrap_or(u64::MAX));
            return Ok(LimitedRead::TooLarge(observed));
        }
        bytes.extend_from_slice(&buffer[..count]);
    }
}

fn file_matches_bytes(path: &Path, expected: &[u8]) -> Result<bool, String> {
    let mut file = fs::File::open(path).map_err(|error| io_error_message(path, &error))?;
    if file
        .metadata()
        .map_err(|error| io_error_message(path, &error))?
        .len()
        != u64::try_from(expected.len()).unwrap_or(u64::MAX)
    {
        return Ok(false);
    }
    let mut offset = 0_usize;
    let mut buffer = [0_u8; OFFSET_CHUNK_BYTES];
    loop {
        let count = file
            .read(&mut buffer)
            .map_err(|error| io_error_message(path, &error))?;
        if count == 0 {
            return Ok(offset == expected.len());
        }
        let end = offset.saturating_add(count);
        if expected.get(offset..end) != Some(&buffer[..count]) {
            return Ok(false);
        }
        offset = end;
    }
}

fn file_too_large_message(path: &Path, actual_bytes: u64, maximum_mib: u64) -> String {
    format!(
        "File too large for line edits: {} is {:.1} MiB (limit: {maximum_mib} MiB).",
        display_path(path),
        actual_bytes as f64 / 1_048_576.0
    )
}

fn resolve_target(requested: &Path) -> Result<PathBuf, String> {
    let metadata =
        fs::symlink_metadata(requested).map_err(|error| io_error_message(requested, &error))?;
    if metadata.file_type().is_symlink() {
        let target = crate::paths::canonical_existing(requested).map_err(|_| {
            format!(
                "Cannot edit {}: it is a symbolic link that does not resolve to a file.",
                display_path(requested)
            )
        })?;
        if !target.is_file() {
            return Err(format!(
                "Cannot edit {}: it is a symbolic link that does not resolve to a file.",
                display_path(requested)
            ));
        }
        Ok(target)
    } else {
        Ok(crate::paths::canonical_existing(requested).unwrap_or_else(|_| requested.to_path_buf()))
    }
}

fn reject_hard_link(path: &Path) -> Result<(), String> {
    if hard_link_count(path)? > 1 {
        return Err(format!(
            "Cannot safely edit {}: it has multiple hard links, and an atomic replace would break them. Duplicate the file to a new path, or remove the extra links first.",
            display_path(path)
        ));
    }
    Ok(())
}

#[cfg(unix)]
fn hard_link_count(path: &Path) -> Result<u64, String> {
    use std::os::unix::fs::MetadataExt;
    fs::metadata(path)
        .map(|metadata| metadata.nlink())
        .map_err(|error| io_error_message(path, &error))
}

#[cfg(windows)]
fn hard_link_count(path: &Path) -> Result<u64, String> {
    use std::fs::File;
    use std::mem::MaybeUninit;
    use std::os::windows::io::AsRawHandle;
    use windows_sys::Win32::Storage::FileSystem::{
        BY_HANDLE_FILE_INFORMATION, GetFileInformationByHandle,
    };

    let file = File::open(path).map_err(|error| io_error_message(path, &error))?;
    let mut info = MaybeUninit::<BY_HANDLE_FILE_INFORMATION>::zeroed();
    let success =
        unsafe { GetFileInformationByHandle(file.as_raw_handle() as _, info.as_mut_ptr()) };
    if success == 0 {
        return Err(io_error_message(path, &std::io::Error::last_os_error()));
    }
    Ok(unsafe { info.assume_init() }.nNumberOfLinks as u64)
}

#[cfg(not(any(unix, windows)))]
fn hard_link_count(_path: &Path) -> Result<u64, String> {
    Ok(1)
}

fn concurrent_message(path: &Path) -> String {
    format!(
        "{} changed on disk during the edit; nothing was written. Re-read it and retry.",
        display_path(path)
    )
}

#[cfg(test)]
mod tests {
    use super::TextDocument;

    #[test]
    fn utf16_mapping_preserves_every_unmodified_raw_byte() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("utf16.txt");
        let mut raw = vec![0xff, 0xfe];
        for unit in "one\r\ntwo".encode_utf16() {
            raw.extend(unit.to_le_bytes());
        }
        std::fs::write(&path, &raw).unwrap();
        let document = TextDocument::open(path.to_str().unwrap(), None, 256).unwrap();
        let start = document.logical_text().find("two").unwrap();
        let end = start + "two".len();
        let mut cursor = document.raw_offset_cursor().unwrap();
        let raw_start = cursor.advance_to(start).unwrap();
        let raw_end = cursor.advance_to(end).unwrap();
        let mut result = Vec::new();
        result.extend_from_slice(&document.original_bytes()[..raw_start]);
        result.extend_from_slice(&document.encode_for_target("TWO").unwrap());
        result.extend_from_slice(&document.original_bytes()[raw_end..]);
        assert_eq!(&result[..12], &raw[..12]);
        assert_eq!(&result[..2], &[0xff, 0xfe]);
    }

    #[cfg(unix)]
    #[test]
    fn dangling_symlink_uses_the_specific_recovery_error() {
        use std::os::unix::fs::symlink;
        let temp = tempfile::tempdir().unwrap();
        let link = temp.path().join("dangling.txt");
        symlink(temp.path().join("missing.txt"), &link).unwrap();
        let error = TextDocument::open(link.to_str().unwrap(), None, 256).unwrap_err();
        assert_eq!(
            error,
            format!(
                "Cannot edit {}: it is a symbolic link that does not resolve to a file.",
                crate::paths::display_path(&link)
            )
        );
    }
}
