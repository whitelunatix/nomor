//! 助手安全审计：shell 执行、文件写入、MCP 配置导入统一落一份 JSONL。
//!
//! 审计必须满足三个条件才有用：
//! 1. **不泄密**：命令里可能带 token，错误信息可能回显 Authorization 头，
//!    所以每个字段在落盘前都过一遍 `redact`。
//! 2. **不无限增长**：单个文件超过阈值就轮转，只保留固定份数。
//! 3. **不互相踩**：多个并发工具调用共用一把进程内锁，行与行不会写花。
//!
//! 审计失败不能影响用户操作本身，所以所有错误都在这里吞掉。

use serde_json::{json, Value};
use std::{
    fs::{self, OpenOptions},
    io::Write,
    path::Path,
    sync::Mutex,
};
use tauri::{AppHandle, Manager, Runtime};

use super::limits::{AUDIT_FIELD_MAX_BYTES, AUDIT_MAX_BYTES, AUDIT_MAX_FILES};
use super::redact::redact_text;

const AUDIT_DIR_NAME: &str = "assistant";
const AUDIT_FILE_STEM: &str = "audit";

/// 进程内串行化：`record` 可能从异步命令和同步命令同时调用。
static AUDIT_LOCK: Mutex<()> = Mutex::new(());

fn audit_file(dir: &Path) -> std::path::PathBuf {
    dir.join(format!("{AUDIT_FILE_STEM}.jsonl"))
}

fn rotated_file(dir: &Path, index: usize) -> std::path::PathBuf {
    dir.join(format!("{AUDIT_FILE_STEM}.{index}.jsonl"))
}

/// 先红act再截断：如果先截断，正好被切开的密钥前缀可能漏过去。
fn truncate_field(text: &str) -> String {
    if text.len() <= AUDIT_FIELD_MAX_BYTES {
        return text.to_string();
    }
    let mut end = AUDIT_FIELD_MAX_BYTES;
    while !text.is_char_boundary(end) {
        end -= 1;
    }
    format!("{}…（已截断）", &text[..end])
}

fn sanitize(value: Value) -> Value {
    match value {
        Value::String(text) => Value::String(truncate_field(&redact_text(&text))),
        Value::Array(items) => Value::Array(items.into_iter().map(sanitize).collect()),
        Value::Object(map) => {
            Value::Object(map.into_iter().map(|(key, value)| (key, sanitize(value))).collect())
        }
        other => other,
    }
}

/// Windows 上 `rename` 不能覆盖已存在的目标，所以每一步都先删目标。
fn rotate(dir: &Path) -> std::io::Result<()> {
    let base = audit_file(dir);
    if !base.exists() {
        return Ok(());
    }
    let oldest = AUDIT_MAX_FILES.saturating_sub(1);
    let oldest_path = rotated_file(dir, oldest);
    if oldest_path.exists() {
        fs::remove_file(&oldest_path)?;
    }
    for index in (1..oldest).rev() {
        let from = rotated_file(dir, index);
        if !from.exists() {
            continue;
        }
        let to = rotated_file(dir, index + 1);
        if to.exists() {
            fs::remove_file(&to)?;
        }
        fs::rename(&from, &to)?;
    }
    let first = rotated_file(dir, 1);
    if first.exists() {
        fs::remove_file(&first)?;
    }
    fs::rename(&base, &first)
}

/// 追加一行；超过阈值先轮转。调用方负责加锁。
fn append_line(dir: &Path, line: &str) -> std::io::Result<()> {
    fs::create_dir_all(dir)?;
    let path = audit_file(dir);
    let too_large = fs::metadata(&path)
        .map(|metadata| metadata.len() >= AUDIT_MAX_BYTES)
        .unwrap_or(false);
    if too_large {
        rotate(dir)?;
    }
    let mut file = OpenOptions::new().create(true).append(true).open(path)?;
    writeln!(file, "{line}")
}

/// 记录一条审计事件。字段名会原样出现在 JSONL 里，调用方不要再拼字符串。
pub(crate) fn record<R: Runtime>(app: &AppHandle<R>, event: &str, fields: &[(&str, Value)]) {
    let Ok(root) = app.path().app_data_dir() else {
        return;
    };
    let dir = root.join(AUDIT_DIR_NAME);
    let mut object = serde_json::Map::new();
    object.insert("ts".to_string(), json!(crate::config::now_ts()));
    object.insert("event".to_string(), json!(event));
    for (key, value) in fields {
        object.insert((*key).to_string(), sanitize(value.clone()));
    }
    let Ok(line) = serde_json::to_string(&Value::Object(object)) else {
        return;
    };
    let _guard = AUDIT_LOCK.lock().unwrap_or_else(|error| error.into_inner());
    let _ = append_line(&dir, &line);
}

#[cfg(test)]
mod tests {
    use super::{
        append_line, audit_file, rotate, sanitize, truncate_field, AUDIT_MAX_BYTES,
        AUDIT_MAX_FILES,
    };
    use serde_json::json;

    fn temp_dir(tag: &str) -> std::path::PathBuf {
        std::env::temp_dir().join(format!(
            "nomo-audit-{tag}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|value| value.as_nanos())
                .unwrap_or(0)
        ))
    }

    #[test]
    fn truncates_long_fields_on_char_boundary_and_redacts_secrets() {
        let secret = format!("Authorization: Bearer sk-{}", "a".repeat(64));
        let text = format!("{secret}\n{}", "中".repeat(10_000));
        let result = truncate_field(&super::redact_text(&text));

        assert!(!result.contains(&"a".repeat(64)), "密钥必须被遮掉");
        assert!(result.ends_with("…（已截断）"));
        assert!(result.len() <= super::AUDIT_FIELD_MAX_BYTES + 32);
        assert!(std::str::from_utf8(result.as_bytes()).is_ok());
    }

    #[test]
    fn sanitizes_nested_structures_without_dropping_shape() {
        let value = sanitize(json!({
            "command": "curl -H 'Authorization: Bearer sk-1234567890abcdef'",
            "nested": ["token=plain-value", 42, {"apiKey": "sk-abcdefghijklmnop"}],
        }));
        let text = serde_json::to_string(&value).expect("json");
        assert!(!text.contains("1234567890abcdef"), "{text}");
        assert!(!text.contains("plain-value"), "{text}");
        assert!(!text.contains("abcdefghijklmnop"), "{text}");
        assert!(text.contains("\"nested\""), "{text}");
        assert!(text.contains("42"), "{text}");
    }

    #[test]
    fn rotates_when_the_active_file_exceeds_the_limit() {
        let dir = temp_dir("rotate");
        std::fs::create_dir_all(&dir).expect("create dir");
        let path = audit_file(&dir);
        let file = std::fs::File::create(&path).expect("create audit");
        file.set_len(AUDIT_MAX_BYTES + 1).expect("grow audit");
        drop(file);

        append_line(&dir, "{\"event\":\"after-rotate\"}").expect("append");

        assert!(path.exists());
        assert!(super::rotated_file(&dir, 1).exists());
        let line = std::fs::read_to_string(&path).expect("read active");
        assert!(line.contains("after-rotate"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn keeps_a_bounded_number_of_rotated_files() {
        let dir = temp_dir("bounded");
        std::fs::create_dir_all(&dir).expect("create dir");
        for index in 0..(AUDIT_MAX_FILES + 3) {
            std::fs::write(audit_file(&dir), format!("generation-{index}\n")).expect("write");
            rotate(&dir).expect("rotate");
        }
        // 轮转后当前文件不存在；补一次正常写入，统计「当前 + 历史」总数。
        append_line(&dir, "{\"event\":\"final\"}").expect("append");

        let files = std::fs::read_dir(&dir)
            .expect("list")
            .flatten()
            .filter(|entry| entry.file_name().to_string_lossy().starts_with("audit"))
            .count();
        assert_eq!(files, AUDIT_MAX_FILES);
        assert!(!super::rotated_file(&dir, AUDIT_MAX_FILES).exists());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
