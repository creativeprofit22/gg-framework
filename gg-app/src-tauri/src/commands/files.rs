//! File/URL commands: dropped paths, attachments, opening paths, images and URLs.

use crate::*;

#[tauri::command]
pub(crate) fn dropped_path_info(paths: Vec<String>) -> Vec<DroppedPathInfo> {
    paths
        .into_iter()
        .map(|path| {
            let is_dir = std::fs::metadata(&path)
                .map(|m| m.is_dir())
                .unwrap_or(false);
            DroppedPathInfo { path, is_dir }
        })
        .collect()
}

/// Cap on a single dropped file's size for base64 attachment — large drops
/// (e.g. multi-GB video) would blow up the base64 payload and the IPC/agent
/// prompt pipeline; point the user at the file path instead via the error.
pub(crate) const MAX_DROPPED_FILE_BYTES: u64 = 100 * 1024 * 1024;

/// Guess a media type from the file extension. Covers the kinds the chat
/// input already accepts (image/video via the attach button, everything else
/// falls back to a generic binary type like a browser's File.type would for
/// an unrecognized extension).
pub(crate) fn guess_media_type(path: &Path) -> String {
    let ext = path
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    match ext.as_str() {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "bmp" => "image/bmp",
        "svg" => "image/svg+xml",
        "mp4" => "video/mp4",
        "mov" => "video/quicktime",
        "webm" => "video/webm",
        "avi" => "video/x-msvideo",
        "mkv" => "video/x-matroska",
        "pdf" => "application/pdf",
        "txt" | "md" => "text/plain",
        _ => "application/octet-stream",
    }
    .to_string()
}

/// A native drag-drop only gives us absolute paths (no browser File object),
/// so a regular file dropped on the window (as opposed to a folder, handled
/// separately by inserting its path into the draft) is read here and handed
/// back as base64 — the same shape `fileToPending` builds for a pasted/picked
/// file — so it attaches identically regardless of how it entered the input.
#[tauri::command]
pub(crate) fn read_dropped_file_attachment(path: String) -> Result<serde_json::Value, String> {
    let p = Path::new(&path);
    let metadata = std::fs::metadata(p).map_err(|e| e.to_string())?;
    if metadata.len() > MAX_DROPPED_FILE_BYTES {
        return Err(format!(
            "{} is too large to attach ({} MB, limit {} MB)",
            path,
            metadata.len() / (1024 * 1024),
            MAX_DROPPED_FILE_BYTES / (1024 * 1024)
        ));
    }
    let bytes = std::fs::read(p).map_err(|e| e.to_string())?;
    let data = base64::engine::general_purpose::STANDARD.encode(bytes);
    let name = p
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| path.clone());
    let media_type = guess_media_type(p);
    Ok(serde_json::json!({ "name": name, "mediaType": media_type, "data": data }))
}

/// Resolve literal paths without reinterpreting URL syntax or trimming filenames.
pub(crate) fn resolve_project_path(cwd: &Path, path: &str) -> Result<PathBuf, String> {
    if path.is_empty() {
        return Err("empty path".into());
    }
    if path.contains("://") {
        return Err("not a file path".into());
    }
    let candidate = PathBuf::from(path);
    let resolved = if candidate.is_absolute() {
        candidate
    } else {
        cwd.join(candidate)
    };
    Ok(strip_extended_prefix(
        resolved
            .canonicalize()
            .map_err(|_| format!("file not found: {}", path))?,
    ))
}

/// Open a literal path against the originating, owned pane's cwd.
#[tauri::command]
pub(crate) fn open_project_path(
    webview: WebviewWindow,
    pane_id: Option<String>,
    path: String,
) -> Result<(), String> {
    let pane_id = pane_id.as_deref().unwrap_or(PRIMARY_PANE_ID);
    let cwd = pane_cwd_for(&webview, pane_id).ok_or("sidecar not ready")?;
    let canonical = resolve_project_path(&cwd, &path)?;
    open_with_default(&canonical.to_string_lossy())
}

/// Cap for an image shown inline in a reply; it travels to the webview as base64.
pub(crate) const MAX_CHAT_IMAGE_BYTES: u64 = 25 * 1024 * 1024;

/// Media type from the file's leading bytes. Only raster formats the webview
/// can show in an `<img>`; SVG is left out (it is a document, not pixels).
pub(crate) fn sniff_image_type(bytes: &[u8]) -> Option<&'static str> {
    if bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        Some("image/png")
    } else if bytes.starts_with(&[0xFF, 0xD8, 0xFF]) {
        Some("image/jpeg")
    } else if bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a") {
        Some("image/gif")
    } else if bytes.len() >= 12 && &bytes[0..4] == b"RIFF" && &bytes[8..12] == b"WEBP" {
        Some("image/webp")
    } else if bytes.starts_with(b"BM") {
        Some("image/bmp")
    } else {
        None
    }
}

/// Read a local image referenced by a reply (`![](/tmp/shot.png)`) so the chat
/// can show it: the webview can't load disk paths itself. Only real image
/// files (checked by content, not just name) under the size cap are returned.
#[tauri::command]
pub(crate) fn read_chat_image(
    webview: WebviewWindow,
    pane_id: Option<String>,
    path: String,
) -> Result<serde_json::Value, String> {
    // Local Fork: literal path against the originating pane's cwd; the webview
    // strips URL syntax first (`projectUrlPath`), as for `open_project_path`.
    let pane_id = pane_id.as_deref().unwrap_or(PRIMARY_PANE_ID);
    let cwd = pane_cwd_for(&webview, pane_id).ok_or("sidecar not ready")?;
    let file = resolve_project_path(&cwd, &path)?;
    let metadata = std::fs::metadata(&file).map_err(|e| e.to_string())?;
    if !metadata.is_file() {
        return Err(format!("not a file: {path}"));
    }
    if metadata.len() > MAX_CHAT_IMAGE_BYTES {
        return Err(format!("image too large to show: {path}"));
    }
    let bytes = std::fs::read(&file).map_err(|e| e.to_string())?;
    let media_type = sniff_image_type(&bytes).ok_or_else(|| format!("not an image: {path}"))?;
    let data = base64::engine::general_purpose::STANDARD.encode(bytes);
    Ok(serde_json::json!({ "mediaType": media_type, "data": data }))
}

/// Image types `open_image_data` will write, mapped to the extension it uses.
/// The extension comes from this fixed list (never from the caller), so the
/// webview cannot drop an executable or script into the temp folder.
pub(crate) fn image_extension_for(media_type: &str) -> Option<&'static str> {
    match media_type {
        "image/png" => Some("png"),
        "image/jpeg" => Some("jpg"),
        "image/gif" => Some("gif"),
        "image/webp" => Some("webp"),
        "image/bmp" => Some("bmp"),
        _ => None,
    }
}

/// Temp file for a chat image that has no file of its own. Named by a hash of
/// the bytes so clicking the same image again reuses one file.
pub(crate) fn image_temp_path(dir: &Path, extension: &str, bytes: &[u8]) -> PathBuf {
    use std::hash::{Hash, Hasher};
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    bytes.hash(&mut hasher);
    dir.join(format!("image-{:016x}.{}", hasher.finish(), extension))
}

/// Open a pasted/attached chat image in the default image viewer. These images
/// live only in memory (base64), so write a copy into the app's per-user cache
/// folder (not the shared system temp dir) and open that.
#[tauri::command]
pub(crate) fn open_image_data(
    webview: WebviewWindow,
    media_type: String,
    data: String,
) -> Result<(), String> {
    let extension =
        image_extension_for(&media_type).ok_or_else(|| format!("not an image: {media_type}"))?;
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(data.as_bytes())
        .map_err(|e| format!("invalid image data: {e}"))?;
    if bytes.is_empty() || bytes.len() as u64 > MAX_DROPPED_FILE_BYTES {
        return Err("image is empty or too large to open".into());
    }
    let dir = webview
        .path()
        .app_cache_dir()
        .map_err(|e| e.to_string())?
        .join("chat-images");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let file = image_temp_path(&dir, extension, &bytes);
    if !file.is_file() {
        std::fs::write(&file, &bytes).map_err(|e| e.to_string())?;
    }
    open_with_default(&file.to_string_lossy())
}

/// Open a web/mail/phone link in the user's default app (chat links, title-bar
/// GitHub links, OAuth pages). Scheme-validated so the webview can't turn this
/// into a local-file opener.
#[tauri::command]
pub(crate) fn open_url(url: String) -> Result<(), String> {
    let trimmed = url.trim();
    if !is_openable_url(trimmed) {
        return Err("only http(s), mailto: and tel: links can be opened".into());
    }
    open_with_default(trimmed)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn open_image_data_only_writes_known_image_extensions() {
        assert_eq!(image_extension_for("image/png"), Some("png"));
        assert_eq!(image_extension_for("image/jpeg"), Some("jpg"));
        assert_eq!(image_extension_for("application/x-sh"), None);
        assert_eq!(image_extension_for("image/svg+xml"), None);
    }

    #[test]
    fn chat_images_are_recognised_by_content_not_name() {
        assert_eq!(
            sniff_image_type(b"\x89PNG\r\n\x1a\nrest"),
            Some("image/png")
        );
        assert_eq!(
            sniff_image_type(&[0xFF, 0xD8, 0xFF, 0xE0]),
            Some("image/jpeg")
        );
        assert_eq!(sniff_image_type(b"GIF89a.."), Some("image/gif"));
        assert_eq!(
            sniff_image_type(b"RIFF\0\0\0\0WEBPVP8 "),
            Some("image/webp")
        );
        assert_eq!(
            sniff_image_type(b"-----BEGIN OPENSSH PRIVATE KEY-----"),
            None
        );
        assert_eq!(
            sniff_image_type(b"<svg xmlns=\"http://www.w3.org/2000/svg\"/>"),
            None
        );
        assert_eq!(sniff_image_type(b""), None);
    }

    #[test]
    fn chat_image_paths_resolve_literally_against_the_pane_cwd() {
        let dir = std::env::temp_dir().join(format!("gg-chat-path-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("shot.png");
        std::fs::write(&file, b"x").unwrap();
        let want = strip_extended_prefix(file.canonicalize().unwrap());
        assert_eq!(resolve_project_path(&dir, "shot.png").unwrap(), want);
        assert_eq!(
            resolve_project_path(Path::new("/"), &file.to_string_lossy()).unwrap(),
            want
        );
        // URL syntax is removed by the webview before the call, never here.
        assert!(resolve_project_path(&dir, "https://example.com/a.png").is_err());
        assert!(resolve_project_path(&dir, "missing.png").is_err());
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn image_temp_path_is_stable_per_image() {
        let dir = Path::new("/tmp/gg");
        let a = image_temp_path(dir, "png", b"one");
        assert_eq!(a, image_temp_path(dir, "png", b"one"));
        assert_ne!(a, image_temp_path(dir, "png", b"two"));
        assert_eq!(a.extension().and_then(|e| e.to_str()), Some("png"));
        assert_eq!(a.parent(), Some(dir));
    }

    #[test]
    fn resolve_project_path_preserves_literal_filenames() {
        let root = std::env::temp_dir().join(format!(
            "gg-path-test-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir(&root).unwrap();
        for name in [
            "report#Log.md",
            "report#L12",
            "my file.md",
            "README.md",
            " leading.md",
        ] {
            std::fs::write(root.join(name), name).unwrap();
        }
        std::fs::create_dir(root.join("project%20copy")).unwrap();
        // Decoys make unintended decoding/truncation observable even when lookup succeeds.
        std::fs::write(root.join("report"), "wrong").unwrap();
        std::fs::create_dir(root.join("project copy")).unwrap();
        for name in [
            "report#Log.md",
            "report#L12",
            "project%20copy",
            "my file.md",
            "README.md",
            " leading.md",
        ] {
            let expected = strip_extended_prefix(root.join(name).canonicalize().unwrap());
            assert_eq!(resolve_project_path(&root, name).unwrap(), expected);
            assert_eq!(
                resolve_project_path(&root, expected.to_str().unwrap()).unwrap(),
                expected
            );
        }
        assert!(resolve_project_path(&root, "").is_err());
        assert!(resolve_project_path(&root, "https://example.com").is_err());
        assert!(resolve_project_path(&root, "README.md#section").is_err());
        #[cfg(not(windows))]
        for name in ["report:12:3", "report?query", " padded "] {
            std::fs::write(root.join(name), name).unwrap();
            assert_eq!(
                resolve_project_path(&root, name).unwrap(),
                root.join(name).canonicalize().unwrap()
            );
        }
        std::fs::remove_dir_all(root).unwrap();
    }
}
