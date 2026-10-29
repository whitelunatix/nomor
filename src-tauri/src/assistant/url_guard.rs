//! 请求地址白名单。
//!
//! 密钥按 `providerId` 从系统凭据管理器取出后由 Rust 注入；如果请求地址也由 webview
//! 任意指定，就等于给渲染进程开了一条「把已保存的 Key 发到任意主机」的通道。
//! 这里把地址绑定到用户在设置里保存的 `baseUrl`：必须同源，且路径落在 baseUrl 之下。
//!
//! 另见 `stream::client()`：客户端禁用了重定向，避免 3xx 把请求（连同密钥）带去别处。

use reqwest::Url;
use serde_json::Value;
use tauri::{AppHandle, Runtime};

use super::prefs::read_assistant_preferences;

fn is_web_url(url: &Url) -> bool {
    matches!(url.scheme(), "http" | "https")
}

/// baseUrl 末尾的 `/` 不参与前缀比较；`https://host` 与 `https://host/` 等价。
fn normalized_path(url: &Url) -> String {
    let path = url.path().trim_end_matches('/');
    if path.is_empty() {
        "/".to_string()
    } else {
        path.to_string()
    }
}

/// 校验 `candidate` 是否允许带着 `base_url` 对应的密钥发出。
///
/// 通过时返回规范化后的 URL，调用方必须使用返回值发请求（而不是原始字符串）。
pub(crate) fn validate_provider_url(base_url: &str, candidate: &str) -> Result<Url, String> {
    let base = Url::parse(base_url.trim())
        .map_err(|_| "服务商 baseUrl 不是有效地址，请在设置中重新填写".to_string())?;
    if !is_web_url(&base) {
        return Err("服务商 baseUrl 必须使用 http 或 https".to_string());
    }
    let Some(base_host) = base.host_str() else {
        return Err("服务商 baseUrl 缺少主机名".to_string());
    };

    let url = Url::parse(candidate.trim())
        .map_err(|_| "请求地址不是有效地址".to_string())?;
    if !is_web_url(&url) {
        return Err("只允许请求 http 或 https 地址".to_string());
    }
    if !url.username().is_empty() || url.password().is_some() {
        return Err("请求地址不能携带用户名或密码".to_string());
    }
    if url.scheme() != base.scheme()
        || url.host_str() != Some(base_host)
        || url.port_or_known_default() != base.port_or_known_default()
    {
        return Err(format!(
            "请求地址与服务商配置不同源：{}",
            url.origin().ascii_serialization()
        ));
    }

    let base_path = normalized_path(&base);
    let path = url.path();
    // `/v1` 允许 `/v1` 与 `/v1/...`，但不允许 `/v1beta` 这类同前缀兄弟路径。
    let allowed = base_path == "/"
        || path == base_path
        || path.starts_with(&format!("{base_path}/"));
    if !allowed {
        return Err(format!(
            "请求路径超出服务商 baseUrl 的范围：{}",
            url.path()
        ));
    }
    Ok(url)
}

fn provider_base_url<R: Runtime>(
    app: &AppHandle<R>,
    provider_id: &str,
) -> Result<String, String> {
    let parsed = read_assistant_preferences(app)?
        .ok_or_else(|| "还没有配置 AI 服务商，请先在设置里保存服务商信息".to_string())?;
    let providers = parsed
        .get("providers")
        .and_then(Value::as_array)
        .ok_or_else(|| "AI 服务商配置缺少 providers 列表".to_string())?;

    providers
        .iter()
        .find(|provider| provider.get("id").and_then(Value::as_str) == Some(provider_id))
        .and_then(|provider| provider.get("baseUrl"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
        .ok_or_else(|| format!("服务商「{provider_id}」没有配置 baseUrl"))
}

/// 命令入口：以配置里的 baseUrl 为唯一真源校验 webview 传来的地址。
pub(crate) fn ensure_provider_url<R: Runtime>(
    app: &AppHandle<R>,
    provider_id: &str,
    candidate: &str,
) -> Result<Url, String> {
    let base = provider_base_url(app, provider_id)?;
    validate_provider_url(&base, candidate)
}

#[cfg(test)]
mod tests {
    use super::validate_provider_url;

    fn ok(base: &str, candidate: &str) -> String {
        validate_provider_url(base, candidate)
            .unwrap_or_else(|error| panic!("应通过校验：{error}"))
            .to_string()
    }

    fn rejected(base: &str, candidate: &str) -> String {
        validate_provider_url(base, candidate)
            .err()
            .unwrap_or_else(|| panic!("应拒绝：{candidate}"))
    }

    #[test]
    fn allows_subpaths_of_the_configured_base_url() {
        let base = "https://api.deepseek.com/v1";
        assert_eq!(
            ok(base, "https://api.deepseek.com/v1/chat/completions"),
            "https://api.deepseek.com/v1/chat/completions"
        );
        assert_eq!(
            ok(base, "https://api.deepseek.com/v1/models"),
            "https://api.deepseek.com/v1/models"
        );
        // baseUrl 末尾带斜杠、请求带查询串也应通过。
        assert_eq!(
            ok(
                "https://api.deepseek.com/v1/",
                "https://api.deepseek.com/v1/chat/completions?beta=true"
            ),
            "https://api.deepseek.com/v1/chat/completions?beta=true"
        );
    }

    #[test]
    fn allows_the_base_url_itself() {
        assert_eq!(
            ok("https://api.anthropic.com/v1", "https://api.anthropic.com/v1"),
            "https://api.anthropic.com/v1"
        );
        assert_eq!(
            ok("http://127.0.0.1:11434/v1", "http://127.0.0.1:11434/v1/models"),
            "http://127.0.0.1:11434/v1/models"
        );
    }

    #[test]
    fn rejects_a_different_host() {
        let error = rejected("https://api.deepseek.com/v1", "https://evil.example/v1/chat");
        assert!(error.contains("不同源"), "{error}");
    }

    #[test]
    fn rejects_a_different_port_or_scheme() {
        assert!(rejected("https://api.example.com/v1", "https://api.example.com:8443/v1/x")
            .contains("不同源"));
        assert!(rejected("https://api.example.com/v1", "http://api.example.com/v1/x")
            .contains("不同源"));
    }

    #[test]
    fn rejects_sibling_paths_that_only_share_a_prefix() {
        let error = rejected("https://api.example.com/v1", "https://api.example.com/v1beta/models");
        assert!(error.contains("范围"), "{error}");
    }

    #[test]
    fn rejects_path_traversal_out_of_the_base_url() {
        // URL 解析会先把 `..` 规范化掉，规范化后必须仍在 baseUrl 之下。
        assert!(rejected("https://api.example.com/v1", "https://api.example.com/v1/../../steal").contains("范围"));
        assert!(rejected("https://api.example.com/v1", "https://api.example.com/v1/%2e%2e/steal").contains("范围"));
    }

    #[test]
    fn rejects_credentials_embedded_in_the_url() {
        assert!(rejected(
            "https://api.example.com/v1",
            "https://user:pass@api.example.com/v1/x"
        )
        .contains("用户名或密码"));
        // `host@evil` 会被解析成 userinfo + 另一台主机；无论先命中哪条规则都必须拒绝。
        let error = rejected("https://api.example.com/v1", "https://api.example.com@evil.example/v1");
        assert!(error.contains("用户名") || error.contains("不同源"), "{error}");
    }

    #[test]
    fn rejects_non_http_schemes_and_garbage() {
        assert!(rejected("https://api.example.com/v1", "file:///C:/Windows/win.ini").contains("http"));
        assert!(rejected("https://api.example.com/v1", "not a url").contains("有效地址"));
        assert!(rejected("", "https://api.example.com/v1").contains("有效地址"));
    }
}
