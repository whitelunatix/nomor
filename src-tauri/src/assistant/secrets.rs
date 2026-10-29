//! API Key 只存放在系统凭据管理器里：既不写进 `config.json`，也不回传给 webview。
//! 前端只能查询「是否已配置」，真正的密钥只在 Rust 发请求时读取一次。

use keyring::{Entry, Error as KeyringError};

const SERVICE: &str = "nomo.assistant";
const MAX_PROVIDER_ID_LEN: usize = 64;

pub(crate) fn validate_provider_id(provider_id: &str) -> Result<(), String> {
    let valid = !provider_id.is_empty()
        && provider_id.len() <= MAX_PROVIDER_ID_LEN
        && provider_id
            .bytes()
            .all(|value| value.is_ascii_alphanumeric() || value == b'-' || value == b'_');
    if valid {
        Ok(())
    } else {
        Err("服务商标识非法".to_string())
    }
}

fn entry(provider_id: &str) -> Result<Entry, String> {
    validate_provider_id(provider_id)?;
    Entry::new(SERVICE, provider_id).map_err(|error| format!("打开系统凭据管理器失败：{error}"))
}

pub(crate) fn get_api_key(provider_id: &str) -> Result<Option<String>, String> {
    match entry(provider_id)?.get_password() {
        Ok(password) => Ok(Some(password)),
        Err(KeyringError::NoEntry) => Ok(None),
        Err(error) => Err(format!("读取 API Key 失败：{error}")),
    }
}

#[tauri::command]
pub(crate) fn assistant_set_api_key(provider_id: String, api_key: String) -> Result<(), String> {
    let api_key = api_key.trim();
    if api_key.is_empty() {
        return Err("API Key 不能为空".to_string());
    }
    entry(&provider_id)?
        .set_password(api_key)
        .map_err(|error| format!("保存 API Key 失败：{error}"))
}

#[tauri::command]
pub(crate) fn assistant_delete_api_key(provider_id: String) -> Result<(), String> {
    match entry(&provider_id)?.delete_credential() {
        Ok(()) => Ok(()),
        // 删除一个本来就不存在的条目视为成功，便于前端幂等清理。
        Err(KeyringError::NoEntry) => Ok(()),
        Err(error) => Err(format!("删除 API Key 失败：{error}")),
    }
}

#[tauri::command]
pub(crate) fn assistant_has_api_key(provider_id: String) -> Result<bool, String> {
    Ok(get_api_key(&provider_id)?.is_some())
}

#[cfg(test)]
mod tests {
    use super::validate_provider_id;

    #[test]
    fn accepts_reasonable_provider_ids() {
        assert!(validate_provider_id("deepseek").is_ok());
        assert!(validate_provider_id("openai-compatible_1").is_ok());
    }

    #[test]
    fn rejects_empty_or_unsafe_provider_ids() {
        assert!(validate_provider_id("").is_err());
        assert!(validate_provider_id("../secret").is_err());
        assert!(validate_provider_id("a b").is_err());
        assert!(validate_provider_id(&"a".repeat(65)).is_err());
    }
}
