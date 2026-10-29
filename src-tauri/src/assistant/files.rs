//! 文件工具：以「当前文档所在目录」为工作区，读写附件与参考资料。
//!
//! 工作区根由当前文档的绝对路径推导，webview 不能另指定根目录；
//! 所有路径必须是相对路径，解析后必须仍在根目录内（拒绝 `..` 与符号链接逃逸）。
//! 写入默认关闭，开启后仍需前端审批；写前把旧内容备份到应用数据目录。

use serde::Serialize;
use serde_json::json;
use sha2::{Digest, Sha256};
use std::{
    fs::{self, File},
    io::Read,
    path::{Component, Path, PathBuf},
    time::{SystemTime, UNIX_EPOCH},
};
use tauri::{AppHandle, Manager, Runtime};

use super::audit;
use super::limits::{
    FILE_BINARY_PROBE_BYTES as BINARY_PROBE_BYTES, FILE_MAX_LIST_DEPTH as MAX_LIST_DEPTH,
    FILE_MAX_LIST_ENTRIES as MAX_LIST_ENTRIES, FILE_MAX_READ_BYTES as MAX_READ_BYTES,
    FILE_MAX_WRITE_BYTES as MAX_WRITE_BYTES,
};
use super::prefs::read_assistant_preferences;

const IGNORED_DIRS: &[&str] = &["node_modules", "dist", "target"];
const RESERVED_DIRS: &[&str] = &[".git", ".nomo"];
const BACKUP_DIR_NAME: &str = "assistant/file-backups";

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct FileReadResult {
    pub(crate) path: String,
    pub(crate) relative_path: String,
    pub(crate) bytes: u64,
    pub(crate) truncated: bool,
    pub(crate) content: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct FileListEntry {
    pub(crate) name: String,
    pub(crate) relative_path: String,
    /// `file` 或 `dir`。
    pub(crate) kind: String,
    pub(crate) size: Option<u64>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct FileListResult {
    pub(crate) root: String,
    pub(crate) path: String,
    pub(crate) truncated: bool,
    pub(crate) entries: Vec<FileListEntry>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct FileWriteResult {
    pub(crate) relative_path: String,
    pub(crate) bytes: usize,
    pub(crate) created: bool,
    pub(crate) backup_path: Option<String>,
    pub(crate) sha256: String,
}

struct Workspace {
    root: PathBuf,
    document: PathBuf,
}

fn workspace(document_path: &str) -> Result<Workspace, String> {
    let trimmed = document_path.trim();
    if trimmed.is_empty() {
        return Err("当前文档还没有保存到磁盘，文件工具不可用".to_string());
    }
    let document = fs::canonicalize(trimmed)
        .map_err(|error| format!("定位当前文档失败：{error}"))?;
    if !document.is_file() {
        return Err("当前文档路径不是普通文件".to_string());
    }
    let root = document
        .parent()
        .ok_or_else(|| "当前文档没有所在目录".to_string())?
        .to_path_buf();
    Ok(Workspace { root, document })
}

/// 只接受工作区内的相对路径；`..`、绝对路径和保留目录一律拒绝。
fn validate_relative(relative: &str) -> Result<PathBuf, String> {
    let trimmed = relative.trim();
    if trimmed.is_empty() {
        return Err("路径不能为空".to_string());
    }
    let path = Path::new(trimmed);
    if path.is_absolute() {
        return Err("只允许使用相对于文档目录的路径".to_string());
    }
    let mut cleaned = PathBuf::new();
    for component in path.components() {
        match component {
            Component::Normal(part) => {
                let name = part.to_string_lossy();
                if name == ".." || RESERVED_DIRS.contains(&name.as_ref()) {
                    return Err(format!("不允许访问「{name}」"));
                }
                cleaned.push(part);
            }
            Component::CurDir => {}
            _ => return Err("只允许使用相对于文档目录的路径".to_string()),
        }
    }
    if cleaned.as_os_str().is_empty() {
        return Err("路径不能为空".to_string());
    }
    Ok(cleaned)
}

#[cfg(windows)]
pub(crate) fn path_within(root: &Path, candidate: &Path) -> bool {
    let root: Vec<String> = root
        .components()
        .map(|part| part.as_os_str().to_string_lossy().to_lowercase())
        .collect();
    let candidate: Vec<String> = candidate
        .components()
        .map(|part| part.as_os_str().to_string_lossy().to_lowercase())
        .collect();
    candidate.len() >= root.len() && candidate[..root.len()] == root[..]
}

#[cfg(not(windows))]
pub(crate) fn path_within(root: &Path, candidate: &Path) -> bool {
    candidate.starts_with(root)
}

#[cfg(windows)]
fn same_path(left: &Path, right: &Path) -> bool {
    left.to_string_lossy().to_lowercase() == right.to_string_lossy().to_lowercase()
}

#[cfg(not(windows))]
fn same_path(left: &Path, right: &Path) -> bool {
    left == right
}

fn display_path(path: &Path) -> String {
    path.to_string_lossy().replace('\\', "/")
}

fn resolve_existing_file(workspace: &Workspace, relative: &str) -> Result<PathBuf, String> {
    let cleaned = validate_relative(relative)?;
    let candidate = workspace.root.join(&cleaned);
    let canonical = fs::canonicalize(&candidate)
        .map_err(|error| format!("读取「{relative}」失败：{error}"))?;
    if !path_within(&workspace.root, &canonical) {
        return Err(format!("「{relative}」指向了文档目录之外"));
    }
    if !canonical.is_file() {
        return Err(format!("「{relative}」不是文件"));
    }
    Ok(canonical)
}

fn resolve_existing_dir(workspace: &Workspace, relative: &str) -> Result<PathBuf, String> {
    if relative.trim().is_empty() {
        return Ok(workspace.root.clone());
    }
    let cleaned = validate_relative(relative)?;
    let candidate = workspace.root.join(&cleaned);
    let canonical = match fs::canonicalize(&candidate) {
        Ok(path) => path,
        Err(error) => return Err(format!("读取目录「{relative}」失败：{error}")),
    };
    if !path_within(&workspace.root, &canonical) {
        return Err(format!("「{relative}」指向了文档目录之外"));
    }
    if !canonical.is_dir() {
        return Err(format!("「{relative}」不是目录"));
    }
    Ok(canonical)
}

/// 解析写入目标：已存在的目标必须不是符号链接；不存在的目标要求父目录已存在且仍在根内。
fn resolve_write_target(workspace: &Workspace, relative: &str) -> Result<(PathBuf, bool), String> {
    let cleaned = validate_relative(relative)?;
    let candidate = workspace.root.join(&cleaned);
    if let Ok(metadata) = fs::symlink_metadata(&candidate) {
        if metadata.file_type().is_symlink() {
            return Err(format!("「{relative}」是符号链接，拒绝写入"));
        }
        if metadata.is_dir() {
            return Err(format!("「{relative}」是目录，不能写入"));
        }
        let canonical = fs::canonicalize(&candidate)
            .map_err(|error| format!("解析「{relative}」失败：{error}"))?;
        if !path_within(&workspace.root, &canonical) {
            return Err(format!("「{relative}」指向了文档目录之外"));
        }
        return Ok((canonical, false));
    }

    // 目标不存在：逐级创建父目录，但每一级都必须留在根内且不能借道符号链接。
    if let Some(relative_parent) = cleaned.parent() {
        let mut current = workspace.root.clone();
        for component in relative_parent.components() {
            let Component::Normal(part) = component else {
                continue;
            };
            current.push(part);
            match fs::symlink_metadata(&current) {
                Ok(metadata) => {
                    if metadata.file_type().is_symlink() {
                        return Err(format!("「{relative}」的路径包含符号链接，拒绝写入"));
                    }
                    if !metadata.is_dir() {
                        return Err(format!("「{relative}」的上级路径不是目录"));
                    }
                }
                Err(_) => {
                    fs::create_dir(&current)
                        .map_err(|error| format!("创建目录失败：{error}"))?;
                }
            }
        }
    }

    let parent = candidate
        .parent()
        .ok_or_else(|| format!("「{relative}」没有父目录"))?;
    let canonical_parent =
        fs::canonicalize(parent).map_err(|error| format!("目标目录不可用：{error}"))?;
    if !path_within(&workspace.root, &canonical_parent) {
        return Err(format!("「{relative}」指向了文档目录之外"));
    }
    let name = candidate
        .file_name()
        .ok_or_else(|| format!("「{relative}」不是有效文件名"))?;
    Ok((canonical_parent.join(name), true))
}

/// 前缀是二进制（含 NUL）或不是 UTF-8 时拒绝；8KB 恰好截断多字节字符时放行。
pub(crate) fn looks_binary(bytes: &[u8], truncated: bool) -> bool {
    let probe = &bytes[..bytes.len().min(BINARY_PROBE_BYTES)];
    if probe.contains(&0) {
        return true;
    }
    match std::str::from_utf8(probe) {
        Ok(_) => false,
        Err(error) => {
            let incomplete_tail = error.error_len().is_none();
            !(truncated && incomplete_tail)
        }
    }
}

pub(crate) fn decode_text(bytes: Vec<u8>, truncated: bool) -> Result<String, String> {
    match String::from_utf8(bytes) {
        Ok(text) => Ok(text.strip_prefix('\u{feff}').unwrap_or(&text).to_string()),
        Err(error) => {
            // 截断点落在多字节字符中间是正常的：保留前面完整的部分。
            let valid_up_to = error.utf8_error().valid_up_to();
            if truncated && error.utf8_error().error_len().is_none() {
                let bytes = error.into_bytes();
                return String::from_utf8(bytes[..valid_up_to].to_vec())
                    .map_err(|_| "文件不是 UTF-8 文本".to_string());
            }
            Err("文件不是 UTF-8 文本（可能是二进制文件）".to_string())
        }
    }
}

pub(crate) fn read_text_file(path: &Path, max_bytes: u64) -> Result<(Vec<u8>, bool), String> {
    let metadata = fs::metadata(path).map_err(|error| format!("读取文件信息失败：{error}"))?;
    let length = metadata.len();
    let truncated = length > max_bytes;
    let file = File::open(path).map_err(|error| format!("打开文件失败：{error}"))?;
    let mut bytes = Vec::with_capacity(length.min(max_bytes) as usize);
    file.take(max_bytes)
        .read_to_end(&mut bytes)
        .map_err(|error| format!("读取文件失败：{error}"))?;
    Ok((bytes, truncated))
}

fn list_dir(base: &Path, depth: usize) -> Result<(Vec<FileListEntry>, bool), String> {
    let mut entries = Vec::new();
    let mut truncated = false;
    let mut stack = vec![(base.to_path_buf(), String::new(), 1usize)];

    while let Some((dir, prefix, level)) = stack.pop() {
        let reader = match fs::read_dir(&dir) {
            Ok(reader) => reader,
            Err(_) => continue,
        };
        let mut current = Vec::new();
        for entry in reader.flatten() {
            let path = entry.path();
            let name = entry.file_name().to_string_lossy().to_string();
            let Ok(metadata) = fs::symlink_metadata(&path) else {
                continue;
            };
            if metadata.file_type().is_symlink() {
                continue;
            }
            let relative = if prefix.is_empty() {
                name.clone()
            } else {
                format!("{prefix}/{name}")
            };
            if metadata.is_dir() {
                if IGNORED_DIRS.contains(&name.as_str()) || RESERVED_DIRS.contains(&name.as_str()) {
                    continue;
                }
                current.push(FileListEntry {
                    name,
                    relative_path: relative.clone(),
                    kind: "dir".to_string(),
                    size: None,
                });
                if level < depth {
                    stack.push((path, relative, level + 1));
                }
            } else if metadata.is_file() {
                current.push(FileListEntry {
                    name,
                    relative_path: relative,
                    kind: "file".to_string(),
                    size: Some(metadata.len()),
                });
            }
        }
        entries.extend(current);
        if entries.len() >= MAX_LIST_ENTRIES {
            truncated = true;
            break;
        }
    }

    entries.truncate(MAX_LIST_ENTRIES);
    // 目录先于文件，同类按路径不区分大小写排序。
    entries.sort_by(|left, right| {
        left.kind.cmp(&right.kind).then_with(|| {
            left.relative_path
                .to_lowercase()
                .cmp(&right.relative_path.to_lowercase())
        })
    });
    Ok((entries, truncated))
}

fn backup_path(dir: &Path, target: &Path, content: &[u8]) -> Result<PathBuf, String> {
    fs::create_dir_all(dir).map_err(|error| format!("创建备份目录失败：{error}"))?;
    let stamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|value| value.as_millis())
        .unwrap_or(0);
    let mut hasher = Sha256::new();
    hasher.update(display_path(target).as_bytes());
    hasher.update(b"\0");
    hasher.update(content);
    let digest = hasher.finalize();
    let suffix: String = digest
        .as_slice()
        .iter()
        .take(4)
        .map(|byte| format!("{byte:02x}"))
        .collect();
    Ok(dir.join(format!("{stamp}-{suffix}.bak")))
}

fn write_text_file(
    workspace: &Workspace,
    relative: &str,
    content: &str,
    backup_dir: &Path,
) -> Result<FileWriteResult, String> {
    if content.len() > MAX_WRITE_BYTES {
        return Err(format!(
            "内容超过 {}MB 上限，请拆分后再写入",
            MAX_WRITE_BYTES / (1024 * 1024)
        ));
    }
    let (target, created) = resolve_write_target(workspace, relative)?;
    if same_path(&target, &workspace.document) {
        return Err("不能写入当前打开的文档；请用 doc_apply_edit 修改正文".to_string());
    }

    let mut backup_path_value = None;
    if !created {
        let old_bytes =
            fs::read(&target).map_err(|error| format!("读取原文件失败：{error}"))?;
        let backup = backup_path(backup_dir, &target, &old_bytes)?;
        fs::write(&backup, &old_bytes).map_err(|error| format!("写入备份失败：{error}"))?;
        backup_path_value = Some(display_path(&backup));
    }

    crate::file_system::write_file_atomically(&target, content.as_bytes())?;
    let mut hasher = Sha256::new();
    hasher.update(content.as_bytes());
    let sha256: String = hasher
        .finalize()
        .as_slice()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect();

    Ok(FileWriteResult {
        relative_path: display_path(&validate_relative(relative)?),
        bytes: content.len(),
        created,
        backup_path: backup_path_value,
        sha256,
    })
}

fn write_backup_dir<R: Runtime>(app: &AppHandle<R>) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|error| format!("定位应用数据目录失败：{error}"))?
        .join(BACKUP_DIR_NAME);
    fs::create_dir_all(&dir).map_err(|error| format!("创建备份目录失败：{error}"))?;
    Ok(dir)
}

/// `fileWriteEnabled` 只认设置里的值；默认关闭。
fn file_write_enabled<R: Runtime>(app: &AppHandle<R>) -> Result<bool, String> {
    let Some(prefs) = read_assistant_preferences(app)? else {
        return Ok(false);
    };
    Ok(prefs
        .get("fileWriteEnabled")
        .and_then(serde_json::Value::as_bool)
        .unwrap_or(false))
}

#[tauri::command]
pub(crate) fn assistant_file_read(
    document_path: String,
    path: String,
    max_bytes: Option<u64>,
) -> Result<FileReadResult, String> {
    let workspace = workspace(&document_path)?;
    let target = resolve_existing_file(&workspace, &path)?;
    let limit = max_bytes
        .unwrap_or(MAX_READ_BYTES)
        .clamp(1, MAX_READ_BYTES);
    let (bytes, truncated) = read_text_file(&target, limit)?;
    if looks_binary(&bytes, truncated) {
        return Err(format!("「{path}」看起来是二进制文件，无法按文本读取"));
    }
    let content = decode_text(bytes, truncated)?;
    let bytes = content.len() as u64;
    Ok(FileReadResult {
        path: display_path(&target),
        relative_path: display_path(&validate_relative(&path)?),
        bytes,
        truncated,
        content,
    })
}

#[tauri::command]
pub(crate) fn assistant_file_list(
    document_path: String,
    path: Option<String>,
    depth: Option<usize>,
) -> Result<FileListResult, String> {
    let workspace = workspace(&document_path)?;
    let relative = path.unwrap_or_default();
    let base = resolve_existing_dir(&workspace, &relative)?;
    let depth = depth.unwrap_or(1).clamp(1, MAX_LIST_DEPTH);
    let (entries, truncated) = list_dir(&base, depth)?;
    Ok(FileListResult {
        root: display_path(&workspace.root),
        path: if relative.trim().is_empty() {
            ".".to_string()
        } else {
            display_path(&validate_relative(&relative)?)
        },
        truncated,
        entries,
    })
}

#[tauri::command]
pub(crate) fn assistant_file_write<R: Runtime>(
    app: AppHandle<R>,
    document_path: String,
    path: String,
    content: String,
) -> Result<FileWriteResult, String> {
    if !file_write_enabled(&app)? {
        return Err("文件写入未开启，请先在设置 → AI 助手里打开「允许 AI 写入文件」".to_string());
    }
    let workspace = workspace(&document_path)?;
    let backup_dir = write_backup_dir(&app)?;
    let result = write_text_file(&workspace, &path, &content, &backup_dir);
    match &result {
        Ok(written) => audit::record(
            &app,
            "file_write",
            &[
                ("documentPath", json!(document_path)),
                ("path", json!(written.relative_path)),
                ("bytes", json!(written.bytes)),
                ("created", json!(written.created)),
                ("sha256", json!(written.sha256)),
            ],
        ),
        Err(error) => audit::record(
            &app,
            "file_write",
            &[
                ("documentPath", json!(document_path)),
                ("path", json!(path)),
                ("result", json!(format!("error={error}"))),
            ],
        ),
    }
    result
}

#[cfg(test)]
mod tests {
    use super::{validate_relative, write_text_file, Workspace};
    use std::path::Path;

    fn temp_root(tag: &str) -> std::path::PathBuf {
        std::env::temp_dir().join(format!(
            "nomo-files-{tag}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|value| value.as_nanos())
                .unwrap_or(0)
        ))
    }

    fn workspace_at(root: &Path) -> Workspace {
        std::fs::create_dir_all(root).expect("create root");
        let document = root.join("main.md");
        std::fs::write(&document, "# main\n").expect("write document");
        Workspace {
            root: std::fs::canonicalize(root).expect("canonical root"),
            document: std::fs::canonicalize(&document).expect("canonical document"),
        }
    }

    #[test]
    fn rejects_traversal_absolute_and_reserved_paths() {
        assert!(validate_relative("../secret").is_err());
        assert!(validate_relative("a/../../secret").is_err());
        assert!(validate_relative("/etc/passwd").is_err());
        assert!(validate_relative("C:\\Windows").is_err());
        assert!(validate_relative(".git/config").is_err());
        assert!(validate_relative(".nomo/state").is_err());
        assert!(validate_relative("notes/a.txt").is_ok());
        assert!(validate_relative("./notes/a.txt").is_ok());
    }

    #[test]
    fn writes_new_file_and_backs_up_existing_one() {
        let root = temp_root("write");
        let workspace = workspace_at(&root);
        let backups = root.join("backups");

        let created = write_text_file(&workspace, "notes/a.txt", "第一版", &backups)
            .expect("create file");
        assert!(created.created);
        assert_eq!(created.bytes, "第一版".len());
        assert!(created.backup_path.is_none());
        assert_eq!(
            std::fs::read_to_string(root.join("notes/a.txt")).expect("read"),
            "第一版"
        );

        let updated = write_text_file(&workspace, "notes/a.txt", "第二版", &backups)
            .expect("update file");
        assert!(!updated.created);
        let backup = updated.backup_path.expect("backup path");
        assert_eq!(std::fs::read_to_string(backup).expect("read backup"), "第一版");
        assert_eq!(
            std::fs::read_to_string(root.join("notes/a.txt")).expect("read"),
            "第二版"
        );

        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn refuses_to_write_the_open_document() {
        let root = temp_root("guard");
        let workspace = workspace_at(&root);
        let error = write_text_file(&workspace, "main.md", "覆盖", &root.join("backups"))
            .expect_err("must reject");
        assert!(error.contains("当前打开的文档"), "{error}");
        assert_eq!(
            std::fs::read_to_string(root.join("main.md")).expect("read"),
            "# main\n"
        );

        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn creates_missing_directories_inside_the_workspace() {
        let root = temp_root("missing");
        let workspace = workspace_at(&root);
        let written = write_text_file(
            &workspace,
            "missing/nested/a.txt",
            "x",
            &root.join("backups"),
        )
        .expect("create nested file");
        assert!(written.created);
        assert_eq!(
            std::fs::read_to_string(root.join("missing/nested/a.txt")).expect("read"),
            "x"
        );

        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn reads_truncate_at_the_byte_limit_without_breaking_utf8() {
        let root = temp_root("read");
        std::fs::create_dir_all(&root).expect("create root");
        let path = root.join("big.txt");
        // 每行 3 字节（两个汉字 + 换行），限制落在字符中间时也不能返回非法 UTF-8。
        let text = "汉字\n".repeat(1000);
        std::fs::write(&path, &text).expect("write");

        let (bytes, truncated) =
            super::read_text_file(&path, 1000).expect("read limited");
        assert!(truncated);
        assert_eq!(bytes.len(), 1000);
        assert!(super::decode_text(bytes, true).is_ok());

        let (whole, not_truncated) = super::read_text_file(&path, 1_000_000).expect("read all");
        assert!(!not_truncated);
        assert_eq!(
            super::decode_text(whole, false).expect("text"),
            text.strip_prefix('\u{feff}').unwrap_or(&text)
        );

        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn rejects_nul_and_invalid_utf8_as_binary() {
        assert!(super::looks_binary(&[0x41, 0x00, 0x42], false));
        assert!(super::looks_binary(&[0xff, 0xfe, 0x41], false));
        assert!(!super::looks_binary("普通文本".as_bytes(), false));
        // 截断恰好切在多字节字符中间时，前缀仍是合法的 UTF-8。
        let text = "汉字".as_bytes();
        let cut = &text[..text.len() - 2];
        assert!(!super::looks_binary(cut, true));
    }

    #[cfg(windows)]
    #[test]
    fn treats_windows_paths_case_insensitively() {
        assert!(super::path_within(
            Path::new(r"C:\Docs\Thesis"),
            Path::new(r"c:\docs\thesis\notes\a.txt")
        ));
        assert!(!super::path_within(
            Path::new(r"C:\Docs\Thesis"),
            Path::new(r"C:\Docs\Thesis2\a.txt")
        ));
    }

    #[cfg(unix)]
    #[test]
    fn refuses_symlinked_targets_outside_the_workspace() {
        let root = temp_root("symlink-root");
        let outside = temp_root("symlink-outside");
        let workspace = workspace_at(&root);
        std::fs::create_dir_all(&outside).expect("create outside");
        std::fs::write(outside.join("secret.txt"), "secret").expect("write secret");
        if std::os::unix::fs::symlink(outside.join("secret.txt"), root.join("link.txt")).is_err() {
            let _ = std::fs::remove_dir_all(&root);
            let _ = std::fs::remove_dir_all(&outside);
            return;
        }

        let read_error = super::resolve_existing_file(&workspace, "link.txt").err();
        assert!(read_error.is_some(), "越界符号链接必须被拒绝");
        assert!(write_text_file(&workspace, "link.txt", "x", &root.join("backups")).is_err());

        // 借道符号链接目录写入同样必须被拒绝。
        if std::os::unix::fs::symlink(&outside, root.join("linkdir")).is_ok() {
            assert!(
                write_text_file(&workspace, "linkdir/new.txt", "x", &root.join("backups"))
                    .is_err()
            );
            assert!(!outside.join("new.txt").exists());
        }

        let _ = std::fs::remove_dir_all(&root);
        let _ = std::fs::remove_dir_all(&outside);
    }
}
