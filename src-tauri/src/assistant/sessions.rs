//! 会话落盘：`<应用数据>/assistant/sessions/<id>.jsonl`。
//! 第一行是元信息，之后每行一条消息记录；记录内容由前端决定，Rust 只做原子写入与索引。

use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{
    fs::{self, File},
    io::Write,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicU64, Ordering},
        Mutex, MutexGuard,
    },
};
use tauri::{AppHandle, Manager, Runtime};

use super::limits::{SESSION_MAX_BYTES as MAX_SESSION_BYTES, SESSION_MAX_COUNT as MAX_SESSIONS};

const SESSIONS_DIR_NAME: &str = "assistant/sessions";
const SESSION_EXTENSION: &str = "jsonl";
const MAX_TITLE_CHARS: usize = 120;
/// 损坏行最多汇报这么多条，避免一次坏文件把错误信息撑爆。
const MAX_WARNINGS: usize = 20;

/// 所有会话文件写操作串行化：两个窗口同时追加时，避免读到同一份旧内容再各自覆盖。
/// 命令本身是同步的，锁只在一次读写期间持有，不会跨 await。
static SESSION_IO: Mutex<()> = Mutex::new(());
/// 临时文件名唯一后缀：旧实现固定用 `.jsonl.tmp`，并发写入会互相截断。
static TEMP_COUNTER: AtomicU64 = AtomicU64::new(0);

fn lock_io() -> MutexGuard<'static, ()> {
    SESSION_IO.lock().unwrap_or_else(|error| error.into_inner())
}

/// 首行元信息。`deny_unknown_fields` 用来把元信息行和普通消息记录区分开：
/// 消息记录里总会有 `role`/`type` 之类字段，不会被误认成元信息。
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct SessionMeta {
    pub(crate) id: String,
    pub(crate) title: String,
    pub(crate) created_at: i64,
    pub(crate) updated_at: i64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SessionSummary {
    pub(crate) id: String,
    pub(crate) title: String,
    pub(crate) created_at: i64,
    pub(crate) updated_at: i64,
    pub(crate) message_count: usize,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SessionPayload {
    pub(crate) meta: SessionMeta,
    pub(crate) records: Vec<Value>,
    /// 损坏行等可诊断信息；读取时跳过坏行，但要让用户知道发生了什么。
    pub(crate) warnings: Vec<String>,
}

fn sessions_dir<R: Runtime>(app: &AppHandle<R>) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|error| format!("定位应用数据目录失败：{error}"))?
        .join(SESSIONS_DIR_NAME);
    fs::create_dir_all(&dir).map_err(|error| format!("创建会话目录失败：{error}"))?;
    Ok(dir)
}

fn session_path<R: Runtime>(app: &AppHandle<R>, id: &str) -> Result<PathBuf, String> {
    crate::config::validate_content_id(id)?;
    Ok(sessions_dir(app)?.join(format!("{id}.{SESSION_EXTENSION}")))
}

fn normalize_title(title: &str) -> String {
    let trimmed = title.trim();
    trimmed.chars().take(MAX_TITLE_CHARS).collect()
}

fn split_contents(contents: &str) -> (Option<SessionMeta>, Vec<Value>, Vec<String>) {
    let mut meta = None;
    let mut records = Vec::new();
    let mut warnings = Vec::new();
    let mut skipped = 0usize;
    let mut is_first = true;
    for (index, line) in contents.lines().enumerate() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        if is_first {
            is_first = false;
            if let Ok(parsed) = serde_json::from_str::<SessionMeta>(line) {
                meta = Some(parsed);
                continue;
            }
        }
        match serde_json::from_str::<Value>(line) {
            Ok(value) => records.push(value),
            Err(error) => {
                skipped += 1;
                if warnings.len() < MAX_WARNINGS {
                    warnings.push(format!(
                        "第 {} 行不是有效的 JSON，已跳过（{error}）",
                        index + 1
                    ));
                }
            }
        }
    }
    if skipped > warnings.len() {
        warnings.push(format!("…另有 {} 行损坏记录被跳过", skipped - warnings.len()));
    }
    (meta, records, warnings)
}

fn serialize_file(meta: &SessionMeta, records: &[Value]) -> Result<String, String> {
    let mut output = serde_json::to_string(meta)
        .map_err(|error| format!("序列化会话元信息失败：{error}"))?;
    output.push('\n');
    for record in records {
        output.push_str(&serde_json::to_string(record).map_err(|error| {
            format!("序列化会话记录失败：{error}")
        })?);
        output.push('\n');
    }
    Ok(output)
}

fn temp_path(path: &Path) -> PathBuf {
    let suffix = format!(
        "{SESSION_EXTENSION}.tmp.{}.{}",
        std::process::id(),
        TEMP_COUNTER.fetch_add(1, Ordering::Relaxed)
    );
    path.with_extension(suffix)
}

fn write_atomic(path: &Path, contents: &str) -> Result<(), String> {
    if contents.len() as u64 > MAX_SESSION_BYTES {
        return Err(size_limit_error());
    }
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|error| format!("创建会话目录失败：{error}"))?;
    }
    let temp_path = temp_path(path);
    let write_result = (|| -> Result<(), String> {
        let mut file =
            File::create(&temp_path).map_err(|error| format!("创建会话文件失败：{error}"))?;
        file.write_all(contents.as_bytes())
            .map_err(|error| format!("写入会话文件失败：{error}"))?;
        file.sync_all()
            .map_err(|error| format!("同步会话文件失败：{error}"))?;
        Ok(())
    })();
    if let Err(error) = write_result {
        let _ = fs::remove_file(&temp_path);
        return Err(error);
    }

    #[cfg(target_os = "windows")]
    {
        use std::os::windows::ffi::OsStrExt;
        use windows_sys::Win32::Storage::FileSystem::{
            MoveFileExW, MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH,
        };
        let source: Vec<u16> = temp_path.as_os_str().encode_wide().chain(Some(0)).collect();
        let target: Vec<u16> = path.as_os_str().encode_wide().chain(Some(0)).collect();
        if unsafe {
            MoveFileExW(
                source.as_ptr(),
                target.as_ptr(),
                MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
            )
        } == 0
        {
            let error = std::io::Error::last_os_error();
            let _ = fs::remove_file(&temp_path);
            return Err(format!("替换会话文件失败：{error}"));
        }
    }
    #[cfg(not(target_os = "windows"))]
    {
        if let Err(error) = fs::rename(&temp_path, path) {
            let _ = fs::remove_file(&temp_path);
            return Err(format!("替换会话文件失败：{error}"));
        }
    }
    Ok(())
}

fn size_limit_error() -> String {
    format!(
        "会话文件已达到 {}MB 上限，请新建会话或清理旧会话后再继续（不会自动删除任何内容）",
        MAX_SESSION_BYTES / (1024 * 1024)
    )
}

fn exceeded_limit_error() -> String {
    format!(
        "会话数量已达到上限（{MAX_SESSIONS} 个），请先删除不用的会话（不会自动删除任何内容）"
    )
}

/// 只统计 `*.jsonl`，临时文件不计数。
fn count_sessions(dir: &Path) -> Result<usize, String> {
    let entries = fs::read_dir(dir).map_err(|error| format!("读取会话目录失败：{error}"))?;
    Ok(entries
        .flatten()
        .filter(|entry| {
            entry.path().extension().and_then(|value| value.to_str()) == Some(SESSION_EXTENSION)
        })
        .count())
}

fn ensure_capacity(dir: &Path, target: &Path, limit: usize) -> Result<(), String> {
    if target.exists() {
        return Ok(());
    }
    if count_sessions(dir)? >= limit {
        return Err(exceeded_limit_error());
    }
    Ok(())
}

fn read_session_file(path: &Path, id: &str) -> Result<SessionPayload, String> {
    let contents = match fs::read_to_string(path) {
        Ok(contents) => contents,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => String::new(),
        Err(error) => return Err(format!("读取会话失败：{error}")),
    };
    let (meta, records, warnings) = split_contents(&contents);
    let mut meta = meta.unwrap_or_else(|| SessionMeta {
        id: id.to_string(),
        title: String::new(),
        created_at: crate::config::now_ts(),
        updated_at: crate::config::now_ts(),
    });
    // 文件名才是 id 的真源，元信息里的 id 可能是复制/改名遗留的旧值。
    meta.id = id.to_string();
    Ok(SessionPayload {
        meta,
        records,
        warnings,
    })
}

fn load_session<R: Runtime>(app: &AppHandle<R>, id: &str) -> Result<SessionPayload, String> {
    let path = session_path(app, id)?;
    read_session_file(&path, id)
}

#[tauri::command]
pub(crate) fn assistant_session_list(app: AppHandle) -> Result<Vec<SessionSummary>, String> {
    let dir = sessions_dir(&app)?;
    let entries = match fs::read_dir(&dir) {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(error) => return Err(format!("读取会话目录失败：{error}")),
    };

    let mut sessions = Vec::new();
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|value| value.to_str()) != Some(SESSION_EXTENSION) {
            continue;
        }
        let id = match path.file_stem().and_then(|value| value.to_str()) {
            Some(id) => id.to_string(),
            None => continue,
        };
        let contents = fs::read_to_string(&path).unwrap_or_default();
        let (meta, records, _) = split_contents(&contents);
        let updated_at = meta
            .as_ref()
            .map(|meta| meta.updated_at)
            .filter(|value| *value > 0)
            .or_else(|| {
                entry
                    .metadata()
                    .ok()
                    .and_then(|metadata| metadata.modified().ok())
                    .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
                    .map(|duration| duration.as_secs() as i64)
            })
            .unwrap_or_default();
        sessions.push(SessionSummary {
            id: id.clone(),
            title: meta
                .as_ref()
                .map(|meta| meta.title.clone())
                .unwrap_or_default(),
            created_at: meta.as_ref().map(|meta| meta.created_at).unwrap_or(updated_at),
            updated_at,
            // 用量记录也会写在 JSONL 里，但不应该算作一条消息。
            message_count: records
                .iter()
                .filter(|record| record.get("role").is_some())
                .count(),
        });
    }
    sessions.sort_by(|left, right| right.updated_at.cmp(&left.updated_at));
    Ok(sessions)
}

#[tauri::command]
pub(crate) fn assistant_session_read(app: AppHandle, id: String) -> Result<SessionPayload, String> {
    load_session(&app, &id)
}

#[tauri::command]
pub(crate) fn assistant_session_append(
    app: AppHandle,
    id: String,
    title: Option<String>,
    records: Vec<Value>,
) -> Result<SessionMeta, String> {
    let _guard = lock_io();
    let path = session_path(&app, &id)?;
    let dir = sessions_dir(&app)?;
    ensure_capacity(&dir, &path, MAX_SESSIONS)?;
    let (existing_meta, mut stored) =
        load_session(&app, &id).map(|payload| (payload.meta, payload.records))?;
    let now = crate::config::now_ts();
    let meta = SessionMeta {
        id: id.clone(),
        title: title
            .map(|value| normalize_title(&value))
            .filter(|value| !value.is_empty())
            .unwrap_or(existing_meta.title),
        created_at: if existing_meta.created_at > 0 {
            existing_meta.created_at
        } else {
            now
        },
        updated_at: now,
    };
    stored.extend(records);
    write_atomic(&path, &serialize_file(&meta, &stored)?)?;
    Ok(meta)
}

/// 用完整记录替换会话内容。
///
/// 重新生成、编辑后重发会截断后续消息，追加式 JSONL 做不到这一点；
/// 这里一次性原子重写，避免留下半轮记录或重复消息。
#[tauri::command]
pub(crate) fn assistant_session_sync(
    app: AppHandle,
    id: String,
    title: Option<String>,
    records: Vec<Value>,
) -> Result<SessionMeta, String> {
    let _guard = lock_io();
    let path = session_path(&app, &id)?;
    let dir = sessions_dir(&app)?;
    ensure_capacity(&dir, &path, MAX_SESSIONS)?;
    let existing = load_session(&app, &id)?;
    let now = crate::config::now_ts();
    let meta = SessionMeta {
        id: id.clone(),
        title: title
            .map(|value| normalize_title(&value))
            .filter(|value| !value.is_empty())
            .unwrap_or(existing.meta.title),
        created_at: if existing.meta.created_at > 0 {
            existing.meta.created_at
        } else {
            now
        },
        updated_at: now,
    };
    write_atomic(&path, &serialize_file(&meta, &records)?)?;
    Ok(meta)
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SessionExportResult {
    pub(crate) path: String,
    pub(crate) bytes: usize,
}

fn render_markdown(meta: &SessionMeta, records: &[Value]) -> String {
    use std::fmt::Write as _;

    let mut output = String::new();
    let title = if meta.title.is_empty() {
        "未命名会话"
    } else {
        meta.title.as_str()
    };
    let _ = writeln!(output, "# {title}\n");
    let _ = writeln!(output, "导出自 Nomor AI 助手。\n");

    for record in records {
        let Some(object) = record.as_object() else {
            continue;
        };
        let role = object.get("role").and_then(Value::as_str).unwrap_or("");
        let content = object.get("content").and_then(Value::as_str).unwrap_or("");
        match role {
            "user" => {
                let _ = writeln!(output, "## 用户\n\n{content}\n");
            }
            "assistant" => {
                let _ = writeln!(output, "## 助手\n");
                if let Some(calls) = object.get("toolCalls").and_then(Value::as_array) {
                    for call in calls {
                        let name = call
                            .get("name")
                            .and_then(Value::as_str)
                            .unwrap_or("tool");
                        let status = call
                            .get("status")
                            .and_then(Value::as_str)
                            .unwrap_or("");
                        let _ = writeln!(output, "- 工具 {name}：{status}");
                    }
                    if !calls.is_empty() {
                        output.push('\n');
                    }
                }
                if !content.is_empty() {
                    let _ = writeln!(output, "{content}\n");
                }
                if let Some(error) = object.get("error").and_then(Value::as_str) {
                    let _ = writeln!(output, "> 错误：{error}\n");
                }
            }
            _ => continue,
        }
    }
    output
}

/// 把会话导出到用户显式选择的路径；Markdown 便于阅读，JSONL 便于备份/迁移。
#[tauri::command]
pub(crate) fn assistant_session_export(
    app: AppHandle,
    id: String,
    path: String,
    format: String,
) -> Result<SessionExportResult, String> {
    let target = PathBuf::from(path.trim());
    if target.as_os_str().is_empty() {
        return Err("导出路径不能为空".to_string());
    }
    let payload = load_session(&app, &id)?;
    let contents = match format.trim().to_ascii_lowercase().as_str() {
        "markdown" | "md" => render_markdown(&payload.meta, &payload.records),
        "jsonl" => serialize_file(&payload.meta, &payload.records)?,
        other => return Err(format!("不支持的导出格式：{other}")),
    };
    crate::file_system::write_file_atomically(&target, contents.as_bytes())?;
    Ok(SessionExportResult {
        path: target.to_string_lossy().to_string(),
        bytes: contents.len(),
    })
}

#[tauri::command]
pub(crate) fn assistant_session_rename(
    app: AppHandle,
    id: String,
    title: String,
) -> Result<SessionMeta, String> {
    let _guard = lock_io();
    let path = session_path(&app, &id)?;
    let payload = load_session(&app, &id)?;
    let title = normalize_title(&title);
    if title.is_empty() {
        return Err("会话标题不能为空".to_string());
    }
    let meta = SessionMeta {
        title,
        updated_at: crate::config::now_ts(),
        ..payload.meta
    };
    write_atomic(&path, &serialize_file(&meta, &payload.records)?)?;
    Ok(meta)
}

#[tauri::command]
pub(crate) fn assistant_session_delete(app: AppHandle, id: String) -> Result<(), String> {
    let _guard = lock_io();
    let path = session_path(&app, &id)?;
    match fs::remove_file(&path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(format!("删除会话失败：{error}")),
    }
}

#[cfg(test)]
mod tests {
    use super::{
        count_sessions, ensure_capacity, normalize_title, read_session_file, render_markdown,
        serialize_file, split_contents, temp_path, write_atomic, SessionMeta, MAX_SESSION_BYTES,
    };
    use serde_json::json;

    #[test]
    fn trims_and_truncates_titles() {
        assert_eq!(normalize_title("  第一篇  "), "第一篇");
        assert_eq!(normalize_title(&"字".repeat(200)).chars().count(), 120);
    }

    #[test]
    fn round_trips_meta_and_records() {
        let meta = SessionMeta {
            id: "s-1".to_string(),
            title: "标题".to_string(),
            created_at: 1,
            updated_at: 2,
        };
        let records = vec![json!({ "role": "user", "content": "你好" })];
        let contents = serialize_file(&meta, &records).expect("serialize");
        let (parsed_meta, parsed_records, warnings) = split_contents(&contents);

        let parsed_meta = parsed_meta.expect("meta");
        assert_eq!(parsed_meta.id, "s-1");
        assert_eq!(parsed_meta.title, "标题");
        assert_eq!(parsed_records, records);
        assert!(warnings.is_empty());
    }

    #[test]
    fn skips_broken_lines_without_losing_valid_records() {
        let contents =
            "{\"id\":\"s-1\"}\n{ broken\n{\"role\":\"user\"}\n\n{\"role\":\"assistant\"}\n";
        let (meta, records, warnings) = split_contents(contents);

        assert_eq!(meta.expect("meta").id, "s-1");
        assert_eq!(records.len(), 2);
        // 坏行不再静默消失：给出行号与原因，方便用户手工修复。
        assert_eq!(warnings.len(), 1);
        assert!(warnings[0].contains("第 2 行"), "{:?}", warnings);
    }

    #[test]
    fn treats_files_without_meta_as_plain_records() {
        let contents = "{\"role\":\"user\"}\n{\"role\":\"assistant\"}\n";
        let (meta, records, warnings) = split_contents(contents);

        assert!(meta.is_none());
        assert_eq!(records.len(), 2);
        assert!(warnings.is_empty());
    }

    fn temp_dir(tag: &str) -> std::path::PathBuf {
        std::env::temp_dir().join(format!(
            "nomo-sessions-{tag}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|value| value.as_nanos())
                .unwrap_or(0)
        ))
    }

    #[test]
    fn temp_files_never_collide() {
        let path = temp_dir("tmp").join("s-1.jsonl");
        let first = temp_path(&path);
        let second = temp_path(&path);

        assert_ne!(first, second);
        let name = first
            .file_name()
            .and_then(|value| value.to_str())
            .expect("file name");
        let pid = std::process::id().to_string();
        assert!(name.starts_with("s-1.jsonl.tmp."), "{name}");
        assert!(name.contains(&pid), "{name}");
        // 临时文件不能被会话列表误当成正式会话。
        assert_ne!(
            first.extension().and_then(|value| value.to_str()),
            Some("jsonl")
        );
    }

    #[test]
    fn refuses_to_write_past_the_size_limit() {
        let root = temp_dir("oversize");
        std::fs::create_dir_all(&root).expect("create root");
        let path = root.join("s-1.jsonl");
        let oversized = "x".repeat(MAX_SESSION_BYTES as usize + 1);

        let error = write_atomic(&path, &oversized).expect_err("must refuse");
        assert!(error.contains("上限"), "{error}");
        assert!(!path.exists());
        // 超限写入也不应留下临时文件。
        assert_eq!(count_sessions(&root).expect("count"), 0);

        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn refuses_new_sessions_past_the_count_limit() {
        let root = temp_dir("count");
        std::fs::create_dir_all(&root).expect("create root");
        for index in 0..2 {
            std::fs::write(root.join(format!("s-{index}.jsonl")), "").expect("write");
        }
        let existing = root.join("s-0.jsonl");
        let fresh = root.join("s-new.jsonl");

        // 已有会话文件不受数量限制影响，可以继续追加。
        assert!(ensure_capacity(&root, &existing, 2).is_ok());
        let error = ensure_capacity(&root, &fresh, 2).expect_err("must refuse");
        assert!(error.contains("上限"), "{error}");
        // 拒绝新建不等于删除旧会话。
        assert_eq!(count_sessions(&root).expect("count"), 2);

        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn renders_markdown_with_tool_summary() {
        let meta = SessionMeta {
            id: "s-1".to_string(),
            title: "导出测试".to_string(),
            created_at: 1,
            updated_at: 2,
        };
        let records = vec![
            json!({ "type": "message", "role": "user", "content": "总结一下" }),
            json!({
                "type": "message",
                "role": "assistant",
                "content": "这是总结。",
                "toolCalls": [{ "name": "doc_outline", "status": "success" }]
            }),
        ];

        let markdown = render_markdown(&meta, &records);

        assert!(markdown.starts_with("# 导出测试"));
        assert!(markdown.contains("## 用户"));
        assert!(markdown.contains("总结一下"));
        assert!(markdown.contains("工具 doc_outline：success"));
        assert!(markdown.contains("这是总结。"));
    }

    #[test]
    fn filename_wins_over_meta_id() {
        let root = temp_dir("meta-id");
        std::fs::create_dir_all(&root).expect("create root");
        let path = root.join("real-id.jsonl");
        std::fs::write(
            &path,
            "{\"id\":\"stale-id\",\"title\":\"标题\",\"createdAt\":1,\"updatedAt\":2}\n",
        )
        .expect("write");

        let payload = read_session_file(&path, "real-id").expect("read");
        assert_eq!(payload.meta.id, "real-id");
        assert_eq!(payload.meta.title, "标题");

        let _ = std::fs::remove_dir_all(&root);
    }
}
