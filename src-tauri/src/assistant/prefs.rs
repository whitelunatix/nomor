//! 读取 Rust 侧需要独立校验的助手设置。
//!
//! 这些值（服务商 baseUrl、技能根目录）不能以 webview 每次传来的参数为准：
//! 请求地址决定密钥发往哪里，技能根目录决定能读哪些文件，都必须来自用户
//! 在设置里保存过的那份配置。

use serde_json::Value;
use tauri::{AppHandle, Runtime};

use crate::config::commands::get_setting_value;

const ASSISTANT_PREFERENCES_KEY: &str = "assistantPreferences";

pub(crate) fn read_assistant_preferences<R: Runtime>(
    app: &AppHandle<R>,
) -> Result<Option<Value>, String> {
    let Some(raw) = get_setting_value(app, ASSISTANT_PREFERENCES_KEY)
        .map_err(|error| format!("读取 AI 设置失败：{error}"))?
    else {
        return Ok(None);
    };
    let value: Value = serde_json::from_str(&raw)
        .map_err(|_| "AI 设置已损坏，请在设置里重新保存".to_string())?;
    Ok(Some(value))
}

/// 取一个字符串字段；空白字符串按「未设置」处理。
pub(crate) fn string_field(value: &Value, key: &str) -> Option<String> {
    value
        .get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|text| !text.is_empty())
        .map(str::to_string)
}
