//! 流式网关：webview 只把「要发什么」交给 Rust，由 Rust 注入 API Key 并发起请求。
//! 响应体经 `Channel` 逐片回传，前端再拼成 `Response` 交给 AI SDK。
//!
//! 两个必须守住的细节：
//! 1. 首包返回时机是「响应头到达」，不能等整个响应体，否则流式就失去了意义。
//! 2. UTF-8 字符可能被网络分片切断，必须按 `valid_up_to()` 增量解码，
//!    不能逐片 `from_utf8_lossy`，否则中文会被替换成 U+FFFD。

use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex, OnceLock,
    },
};
use tauri::ipc::Channel;
use tauri::{AppHandle, State};

use super::limits::{
    CONNECT_TIMEOUT, MAX_PROBE_BODY_CHARS, MAX_PROBE_BYTES, MAX_STREAM_BYTES, PROBE_TIMEOUT,
    STREAM_IDLE_TIMEOUT,
};
use super::secrets;
use super::url_guard::ensure_provider_url;

/// 请求体里的鉴权方式；`none` 用于本地自建、无需密钥的服务。
#[derive(Clone, Copy, Debug, Default, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) enum AuthStyle {
    #[default]
    Bearer,
    XApiKey,
    None,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct StreamRequest {
    /// 前端生成的流标识，用于之后取消。
    pub(crate) stream_id: String,
    pub(crate) provider_id: String,
    pub(crate) url: String,
    #[serde(default)]
    pub(crate) headers: Vec<(String, String)>,
    pub(crate) body: String,
    #[serde(default)]
    pub(crate) auth: AuthStyle,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct StreamStartInfo {
    pub(crate) status: u16,
    pub(crate) headers: Vec<(String, String)>,
}

/// 通道只走正文分片，响应头随命令返回值一起交回前端，
/// 这样就不依赖「通道消息」与「命令返回值」的到达顺序。
#[derive(Clone, Debug, Serialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub(crate) enum StreamEvent {
    Chunk {
        data: String,
    },
    End,
    Error {
        message: String,
    },
}

#[derive(Default)]
pub(crate) struct StreamRegistry {
    tasks: Arc<Mutex<HashMap<String, tauri::async_runtime::JoinHandle<()>>>>,
}

impl StreamRegistry {
    fn lock_tasks(
        &self,
    ) -> std::sync::MutexGuard<'_, HashMap<String, tauri::async_runtime::JoinHandle<()>>> {
        // 任务线程 panic 不应让「取消」永久失效；锁里只有句柄，恢复数据是安全的。
        self.tasks.lock().unwrap_or_else(|error| error.into_inner())
    }

    /// 任务可能在上面的 `spawn` 与这次插入之间就跑完了。
    /// 用 `finished` 标记在同一把锁下仲裁，避免留下永远无法清理的死句柄。
    fn insert(
        &self,
        stream_id: String,
        handle: tauri::async_runtime::JoinHandle<()>,
        finished: &AtomicBool,
    ) {
        let mut tasks = self.lock_tasks();
        if finished.load(Ordering::SeqCst) {
            return;
        }
        if let Some(previous) = tasks.insert(stream_id, handle) {
            previous.abort();
        }
    }

    fn take(&self, stream_id: &str) -> Option<tauri::async_runtime::JoinHandle<()>> {
        self.lock_tasks().remove(stream_id)
    }
}

/// 自然结束/出错时清理登记，并把「已结束」写在锁内，供 `insert` 判断竞态。
fn retire(
    tasks: &Mutex<HashMap<String, tauri::async_runtime::JoinHandle<()>>>,
    stream_id: &str,
    finished: &AtomicBool,
) {
    let mut tasks = tasks.lock().unwrap_or_else(|error| error.into_inner());
    tasks.remove(stream_id);
    finished.store(true, Ordering::SeqCst);
}

fn client() -> Result<&'static reqwest::Client, String> {
    static CLIENT: OnceLock<Result<reqwest::Client, String>> = OnceLock::new();
    CLIENT
        .get_or_init(|| {
            reqwest::Client::builder()
                .connect_timeout(CONNECT_TIMEOUT)
                // 3xx 会把请求（含 Rust 注入的密钥）带去 Location 指向的主机；
                // 地址白名单只覆盖首个请求，所以这里干脆不跟随重定向。
                .redirect(reqwest::redirect::Policy::none())
                .build()
                .map_err(|error| format!("初始化网络客户端失败：{error}"))
        })
        .as_ref()
        .map_err(Clone::clone)
}

fn is_reserved_header(name: &str) -> bool {
    matches!(
        name.to_ascii_lowercase().as_str(),
        "host" | "content-length" | "authorization" | "x-api-key"
    )
}

/// 只有前端显式允许的请求头会透传；密钥类请求头由 Rust 独占写入。
fn apply_headers(
    mut builder: reqwest::RequestBuilder,
    headers: &[(String, String)],
) -> reqwest::RequestBuilder {
    for (name, value) in headers {
        if is_reserved_header(name) {
            continue;
        }
        builder = builder.header(name, value);
    }
    builder
}

fn apply_auth(
    builder: reqwest::RequestBuilder,
    provider_id: &str,
    auth: AuthStyle,
) -> Result<reqwest::RequestBuilder, String> {
    if auth == AuthStyle::None {
        return Ok(builder);
    }
    let key = secrets::get_api_key(provider_id)?
        .ok_or_else(|| format!("尚未配置服务商「{provider_id}」的 API Key"))?;
    Ok(match auth {
        AuthStyle::Bearer => builder.header("authorization", format!("Bearer {key}")),
        AuthStyle::XApiKey => builder.header("x-api-key", key),
        AuthStyle::None => builder,
    })
}

#[tauri::command]
pub(crate) async fn assistant_stream_start(
    app: AppHandle,
    request: StreamRequest,
    on_event: Channel<StreamEvent>,
    registry: State<'_, StreamRegistry>,
) -> Result<StreamStartInfo, String> {
    // 密钥按 providerId 注入，所以地址必须绑定到该服务商保存的 baseUrl。
    let url = ensure_provider_url(&app, &request.provider_id, &request.url)?;
    let builder = client()?.post(url).body(request.body.clone());
    let builder = apply_headers(builder, &request.headers);
    let builder = apply_auth(builder, &request.provider_id, request.auth)?;

    // 连接失败直接抛给前端：`fetch` 的语义就是 reject，而不是返回一个空响应。
    let response = builder
        .send()
        .await
        .map_err(|error| format!("请求服务商失败：{error}"))?;

    let status = response.status().as_u16();
    let headers = response
        .headers()
        .iter()
        .filter_map(|(name, value)| {
            value
                .to_str()
                .ok()
                .map(|value| (name.as_str().to_string(), value.to_string()))
        })
        .collect::<Vec<_>>();

    let stream_id = request.stream_id;
    let tasks = registry.tasks.clone();
    let finished_id = stream_id.clone();
    let finished = Arc::new(AtomicBool::new(false));
    let finished_task = finished.clone();
    let handle = tauri::async_runtime::spawn(async move {
        let mut stream = response.bytes_stream();
        let mut decoder = Utf8StreamDecoder::default();
        let mut total = 0usize;
        let mut failure: Option<String> = None;
        loop {
            let next = match tokio::time::timeout(STREAM_IDLE_TIMEOUT, stream.next()).await {
                Ok(next) => next,
                Err(_) => {
                    failure = Some(format!(
                        "服务商 {} 秒没有返回新数据，已停止",
                        STREAM_IDLE_TIMEOUT.as_secs()
                    ));
                    break;
                }
            };
            match next {
                Some(Ok(bytes)) => {
                    total += bytes.len();
                    if total > MAX_STREAM_BYTES {
                        failure = Some(format!(
                            "响应超过 {} MB 上限，已停止",
                            MAX_STREAM_BYTES / 1024 / 1024
                        ));
                        break;
                    }
                    let text = decoder.push(&bytes);
                    if !text.is_empty()
                        && on_event.send(StreamEvent::Chunk { data: text }).is_err()
                    {
                        // 前端已经放弃这条流（例如用户点了停止），不必再读。
                        break;
                    }
                }
                Some(Err(error)) => {
                    failure = Some(format!("读取响应流失败：{error}"));
                    break;
                }
                None => break,
            }
        }
        flush_tail(&on_event, &mut decoder);
        match failure {
            Some(message) => {
                let _ = on_event.send(StreamEvent::Error { message });
            }
            None => {
                let _ = on_event.send(StreamEvent::End);
            }
        }
        retire(&tasks, &finished_id, &finished_task);
    });
    registry.insert(stream_id, handle, &finished);
    Ok(StreamStartInfo { status, headers })
}

fn flush_tail(on_event: &Channel<StreamEvent>, decoder: &mut Utf8StreamDecoder) {
    let tail = decoder.finish();
    if !tail.is_empty() {
        let _ = on_event.send(StreamEvent::Chunk { data: tail });
    }
}

#[tauri::command]
pub(crate) fn assistant_stream_cancel(
    stream_id: String,
    registry: State<'_, StreamRegistry>,
) -> Result<(), String> {
    if let Some(handle) = registry.take(&stream_id) {
        handle.abort();
    }
    Ok(())
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ProbeRequest {
    pub(crate) provider_id: String,
    pub(crate) url: String,
    #[serde(default = "default_probe_method")]
    pub(crate) method: String,
    #[serde(default)]
    pub(crate) headers: Vec<(String, String)>,
    #[serde(default)]
    pub(crate) body: Option<String>,
    #[serde(default)]
    pub(crate) auth: AuthStyle,
}

fn default_probe_method() -> String {
    "GET".to_string()
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ProbeResponse {
    pub(crate) status: u16,
    pub(crate) body: String,
}

/// 连通性测试与模型列表共用：不解析业务结构，只把状态码和截断后的原文交回前端。
#[tauri::command]
pub(crate) async fn assistant_probe(
    app: AppHandle,
    request: ProbeRequest,
) -> Result<ProbeResponse, String> {
    let url = ensure_provider_url(&app, &request.provider_id, &request.url)?;
    let method = reqwest::Method::from_bytes(request.method.to_ascii_uppercase().as_bytes())
        .map_err(|_| format!("不支持的请求方法：{}", request.method))?;
    let builder = client()?.request(method, url).timeout(PROBE_TIMEOUT);
    let builder = apply_headers(builder, &request.headers);
    let mut builder = apply_auth(builder, &request.provider_id, request.auth)?;
    if let Some(body) = request.body {
        builder = builder.header("content-type", "application/json").body(body);
    }

    let response = builder
        .send()
        .await
        .map_err(|error| format!("请求服务商失败：{error}"))?;
    let status = response.status().as_u16();
    // 只读到够展示错误的长度就停，避免先缓冲整个响应体（模型列表可能很大）。
    let mut stream = response.bytes_stream();
    let mut bytes = Vec::new();
    while bytes.len() < MAX_PROBE_BYTES {
        match stream.next().await {
            Some(Ok(chunk)) => bytes.extend_from_slice(&chunk),
            Some(Err(error)) => return Err(format!("读取响应失败：{error}")),
            None => break,
        }
    }
    bytes.truncate(MAX_PROBE_BYTES);
    let text = String::from_utf8_lossy(&bytes);
    Ok(ProbeResponse {
        status,
        body: text.chars().take(MAX_PROBE_BODY_CHARS).collect(),
    })
}

/// 网络分片可能把一个多字节字符切成两半。保留不完整尾部，下一片再拼。
#[derive(Default)]
pub(crate) struct Utf8StreamDecoder {
    pending: Vec<u8>,
}

impl Utf8StreamDecoder {
    pub(crate) fn push(&mut self, bytes: &[u8]) -> String {
        self.pending.extend_from_slice(bytes);
        match std::str::from_utf8(&self.pending) {
            Ok(text) => {
                let decoded = text.to_string();
                self.pending.clear();
                decoded
            }
            Err(error) => {
                let valid = error.valid_up_to();
                let mut decoded = String::new();
                if valid > 0 {
                    if let Ok(text) = std::str::from_utf8(&self.pending[..valid]) {
                        decoded.push_str(text);
                    }
                    self.pending.drain(..valid);
                }
                // UTF-8 序列最长 4 字节：留下 4 字节以上仍未读完，说明确有非法字节，
                // 只能用替换字符兜底，否则 pending 会无限增长。
                if self.pending.len() >= 4 && std::str::from_utf8(&self.pending).is_err() {
                    decoded.push_str(&String::from_utf8_lossy(&self.pending));
                    self.pending.clear();
                }
                decoded
            }
        }
    }

    pub(crate) fn finish(&mut self) -> String {
        if self.pending.is_empty() {
            return String::new();
        }
        let text = String::from_utf8_lossy(&self.pending).into_owned();
        self.pending.clear();
        text
    }
}

#[cfg(test)]
mod tests {
    use super::Utf8StreamDecoder;

    #[test]
    fn decodes_whole_text() {
        let mut decoder = Utf8StreamDecoder::default();
        assert_eq!(decoder.push("你好".as_bytes()), "你好");
        assert_eq!(decoder.finish(), "");
    }

    #[test]
    fn keeps_split_multibyte_character_for_next_chunk() {
        let bytes = "中文".as_bytes();
        let mut decoder = Utf8StreamDecoder::default();
        let first = decoder.push(&bytes[..1]);
        let second = decoder.push(&bytes[1..]);
        assert_eq!(format!("{first}{second}"), "中文");
    }

    #[test]
    fn decodes_every_chunk_boundary_without_replacement_chars() {
        let text = "data: {\"text\":\"流式中文，不能出现替换字符\"}\n\n";
        let bytes = text.as_bytes();
        for split in 0..bytes.len() {
            let mut decoder = Utf8StreamDecoder::default();
            let joined = format!("{}{}", decoder.push(&bytes[..split]), decoder.push(&bytes[split..]));
            assert_eq!(joined, text, "split at {split}");
            assert!(!joined.contains('\u{FFFD}'));
        }
    }

    #[test]
    fn flushes_invalid_bytes_instead_of_buffering_forever() {
        let mut decoder = Utf8StreamDecoder::default();
        let mut output = decoder.push(&[0xE4, 0xB8]); // 一个被截断的三字节字符
        assert_eq!(output, "");
        output.push_str(&decoder.push(b"ok"));
        assert!(output.ends_with("ok"));
        assert!(output.contains('\u{FFFD}') || output.starts_with("ok"));
    }

    #[test]
    fn finish_flushes_incomplete_tail() {
        let mut decoder = Utf8StreamDecoder::default();
        assert_eq!(decoder.push(&[0xE4, 0xB8]), "");
        assert_eq!(decoder.finish(), "\u{FFFD}");
        assert_eq!(decoder.finish(), "");
    }
}
