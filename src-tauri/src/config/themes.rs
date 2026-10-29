//! 用户自定义主题文件的存储：应用数据目录下的 `themes/<id>.json`。
//!
//! Rust 侧只负责文件边界（ID 形状、扩展名、大小与数量上限、原子写入），主题内容的结构与令牌
//! 校验由前端主题注册表完成；前端校验通过后才会调用保存命令。

use crate::config::content_store_dir;
use serde::Serialize;
use std::{
    fs,
    path::{Path, PathBuf},
};
use tauri::AppHandle;

pub(crate) const THEMES_DIR_NAME: &str = "themes";
/// 完整主题约 10 KB；上限留足注释和格式空间，同时拦截误选的大文件。
const MAX_THEME_FILE_BYTES: u64 = 256 * 1024;
/// 设置页一次性列出全部主题；上限防止目录被大量文件填充后拖慢启动。
const MAX_USER_THEMES: usize = 64;
/// 与前端 `USER_THEME_ID_PATTERN` 保持一致：`user-` 前缀避免与内置主题 ID 冲突。
const USER_THEME_ID_PREFIX: &str = "user-";
const MAX_USER_THEME_ID_LENGTH: usize = 64;

#[derive(Debug, Serialize)]
pub(crate) struct UserThemeFilePayload {
    pub(crate) id: String,
    pub(crate) content: String,
}

/// 列出已保存的用户主题原文，按 ID 排序。
///
/// 单个文件不可读、过大或文件名不合规时跳过并记录日志，不影响其他主题。
#[tauri::command]
pub(crate) fn list_user_themes(app: AppHandle) -> Result<Vec<UserThemeFilePayload>, String> {
    list_user_themes_in(&content_store_dir(&app, THEMES_DIR_NAME)?)
}

/// 读取用户在文件对话框中选择的主题文件原文，供前端解析校验。
#[tauri::command]
pub(crate) fn read_user_theme_source(path: String) -> Result<String, String> {
    let path = PathBuf::from(path);
    require_json_extension(&path)?;
    read_limited_text(&path)
}

/// 保存已通过前端校验的主题原文；同 ID 主题会被覆盖。
#[tauri::command]
pub(crate) fn save_user_theme(app: AppHandle, id: String, content: String) -> Result<(), String> {
    save_user_theme_in(&content_store_dir(&app, THEMES_DIR_NAME)?, &id, &content)
}

/// 删除用户主题文件；文件不存在视为成功（幂等）。
#[tauri::command]
pub(crate) fn delete_user_theme(app: AppHandle, id: String) -> Result<(), String> {
    let path = user_theme_path(&content_store_dir(&app, THEMES_DIR_NAME)?, &id)?;
    if path.exists() {
        fs::remove_file(path).map_err(|error| format!("删除主题失败：{error}"))?;
    }
    Ok(())
}

/// 把主题模板写到用户在保存对话框中选择的 `.json` 路径。
#[tauri::command]
pub(crate) fn write_user_theme_template(path: String, content: String) -> Result<(), String> {
    let path = PathBuf::from(path);
    require_json_extension(&path)?;
    require_content_size(&content)?;
    write_atomically(&path, &content)
}

fn list_user_themes_in(directory: &Path) -> Result<Vec<UserThemeFilePayload>, String> {
    let entries = match fs::read_dir(directory) {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(error) => return Err(format!("读取主题目录失败：{error}")),
    };
    let mut themes = Vec::new();
    for entry in entries.flatten() {
        let path = entry.path();
        let Some(id) = path
            .file_name()
            .and_then(|name| name.to_str())
            .and_then(|name| name.strip_suffix(".json"))
        else {
            continue;
        };
        if validate_user_theme_id(id).is_err() {
            continue;
        }
        match read_limited_text(&path) {
            Ok(content) => themes.push(UserThemeFilePayload {
                id: id.to_string(),
                content,
            }),
            Err(error) => {
                crate::app_logger::warn("Themes", &format!("跳过主题文件 {id}：{error}"));
            }
        }
    }
    themes.sort_by(|left, right| left.id.cmp(&right.id));
    if themes.len() > MAX_USER_THEMES {
        crate::app_logger::warn(
            "Themes",
            &format!("用户主题超过 {MAX_USER_THEMES} 个，仅加载前 {MAX_USER_THEMES} 个"),
        );
        themes.truncate(MAX_USER_THEMES);
    }
    Ok(themes)
}

fn save_user_theme_in(directory: &Path, id: &str, content: &str) -> Result<(), String> {
    let path = user_theme_path(directory, id)?;
    require_content_size(content)?;
    if !path.exists() {
        let existing = list_user_themes_in(directory)?.len();
        if existing >= MAX_USER_THEMES {
            return Err(format!("最多保存 {MAX_USER_THEMES} 个自定义主题"));
        }
    }
    fs::create_dir_all(directory).map_err(|error| format!("创建主题目录失败：{error}"))?;
    write_atomically(&path, content)
}

fn validate_user_theme_id(id: &str) -> Result<(), String> {
    let Some(rest) = id.strip_prefix(USER_THEME_ID_PREFIX) else {
        return Err("主题 ID 必须以 user- 开头".to_string());
    };
    let valid = id.len() <= MAX_USER_THEME_ID_LENGTH
        && !rest.is_empty()
        && rest.split('-').all(|part| {
            !part.is_empty()
                && part
                    .bytes()
                    .all(|value| value.is_ascii_lowercase() || value.is_ascii_digit())
        });
    if valid {
        Ok(())
    } else {
        Err("主题 ID 只能包含小写字母、数字和单个连字符".to_string())
    }
}

fn user_theme_path(directory: &Path, id: &str) -> Result<PathBuf, String> {
    validate_user_theme_id(id)?;
    Ok(directory.join(format!("{id}.json")))
}

fn require_json_extension(path: &Path) -> Result<(), String> {
    let is_json = path
        .extension()
        .and_then(|value| value.to_str())
        .is_some_and(|value| value.eq_ignore_ascii_case("json"));
    if is_json {
        Ok(())
    } else {
        Err("主题文件必须是 .json 文件".to_string())
    }
}

fn require_content_size(content: &str) -> Result<(), String> {
    if content.len() as u64 > MAX_THEME_FILE_BYTES {
        Err("主题文件过大（上限 256 KB）".to_string())
    } else {
        Ok(())
    }
}

fn read_limited_text(path: &Path) -> Result<String, String> {
    let metadata = fs::metadata(path).map_err(|error| format!("读取主题文件失败：{error}"))?;
    if !metadata.is_file() {
        return Err("主题路径不是文件".to_string());
    }
    if metadata.len() > MAX_THEME_FILE_BYTES {
        return Err("主题文件过大（上限 256 KB）".to_string());
    }
    fs::read_to_string(path).map_err(|error| format!("读取主题文件失败：{error}"))
}

/// 先写同目录临时文件再替换，避免写入中断留下半个 JSON。
fn write_atomically(path: &Path, content: &str) -> Result<(), String> {
    let temp_path = path.with_extension("json.tmp");
    fs::write(&temp_path, content.as_bytes()).map_err(|error| format!("写入主题失败：{error}"))?;
    #[cfg(target_os = "windows")]
    if path.exists() {
        fs::remove_file(path).map_err(|error| format!("替换主题失败：{error}"))?;
    }
    fs::rename(&temp_path, path).map_err(|error| format!("替换主题失败：{error}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "nomo-themes-{name}-{}-{}",
            std::process::id(),
            crate::config::now_ts()
        ));
        let _ = fs::remove_dir_all(&dir);
        dir
    }

    #[test]
    fn validates_user_theme_ids() {
        assert!(validate_user_theme_id("user-ocean").is_ok());
        assert!(validate_user_theme_id("user-ocean-2").is_ok());
        for id in [
            "nomo-default",
            "user-",
            "user--a",
            "user-A",
            "user-a/b",
            "user-../x",
        ] {
            assert!(validate_user_theme_id(id).is_err(), "{id}");
        }
    }

    #[test]
    fn saves_lists_and_skips_invalid_files() {
        let dir = temp_dir("list");
        assert!(list_user_themes_in(&dir).unwrap().is_empty());
        save_user_theme_in(&dir, "user-b", "{\"b\":1}").unwrap();
        save_user_theme_in(&dir, "user-a", "{\"a\":1}").unwrap();
        save_user_theme_in(&dir, "user-a", "{\"a\":2}").unwrap();
        fs::write(dir.join("nomo-default.json"), "{}").unwrap();
        fs::write(dir.join("notes.txt"), "x").unwrap();

        let themes = list_user_themes_in(&dir).unwrap();
        let ids: Vec<_> = themes.iter().map(|theme| theme.id.as_str()).collect();
        assert_eq!(ids, ["user-a", "user-b"]);
        assert_eq!(themes[0].content, "{\"a\":2}");
        assert!(save_user_theme_in(&dir, "../x", "{}").is_err());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn rejects_oversized_content_and_non_json_paths() {
        let dir = temp_dir("limits");
        let big = "x".repeat(MAX_THEME_FILE_BYTES as usize + 1);
        assert!(save_user_theme_in(&dir, "user-big", &big).is_err());
        assert!(require_json_extension(Path::new("/tmp/theme.JSON")).is_ok());
        assert!(require_json_extension(Path::new("/tmp/theme.txt")).is_err());
        let _ = fs::remove_dir_all(&dir);
    }
}
