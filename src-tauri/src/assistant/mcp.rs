//! MCP 客户端。
//!
//! 配置文件只支持市面通用的一种格式：应用数据目录下的 `mcp.json`，
//! 顶层是 `mcpServers` 对象（Claude Desktop / Claude Code / Cursor / Cline 通用）。
//! 条目有 `url` 走 streamable HTTP，有 `command` 走 stdio 子进程；
//! `disabled`、`trusted` 是本应用的扩展字段，缺省视为关闭 / 不信任。
//!
//! 连接按需惰性建立，进程句柄留在这个模块里；webview 只拿到工具清单和调用结果。

use process_wrap::tokio::CommandWrap;
#[cfg(windows)]
use process_wrap::tokio::{CreationFlags, JobObject};
use rmcp::{
    model::{
        CallToolRequestParams, ClientCapabilities, ClientConfig, Implementation, JsonObject,
        PaginatedRequestParams, Tool,
    },
    service::{RoleClient, RunningService},
    transport::{
        child_process::TokioChildProcess,
        streamable_http_client::{
            StreamableHttpClientTransport, StreamableHttpClientTransportConfig,
        },
    },
    ServiceExt,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, HashMap, VecDeque},
    fs,
    path::{Path, PathBuf},
    sync::Arc,
    time::Instant,
};
use tauri::{AppHandle, Manager, Runtime, State};
use tokio::{sync::Mutex, task::AbortHandle};

use super::audit;
use super::limits::{
    MCP_CALL_TIMEOUT as CALL_TIMEOUT, MCP_CONNECT_TIMEOUT as CONNECT_TIMEOUT,
    MCP_FAILURE_COOLDOWN as FAILURE_COOLDOWN, MCP_HEALTH_TIMEOUT as HEALTH_TIMEOUT,
    MCP_LIST_TOOLS_TIMEOUT as LIST_TOOLS_TIMEOUT,
    MCP_MAX_CALL_ID_LENGTH as MAX_CALL_ID_LENGTH,
    MCP_MAX_CANCELLED_CALLS as MAX_CANCELLED_CALLS,
    MCP_MAX_RESULT_BYTES as MAX_CALL_RESULT_BYTES, MCP_MAX_TOOL_PAGES as MAX_TOOL_PAGES,
};

const MCP_FILE_NAME: &str = "mcp.json";
const DEFAULT_CONFIG_TEXT: &str = "{\n  \"mcpServers\": {}\n}\n";

/// `mcp.json` 顶层结构。未知字段在读取时忽略、写回时按原文保存，
/// 因此设置页编辑的是原始文本，不会丢掉别的客户端写入的配置。
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct McpFile {
    #[serde(default, rename = "mcpServers")]
    mcp_servers: BTreeMap<String, McpServerEntry>,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct McpServerEntry {
    #[serde(default)]
    command: Option<String>,
    #[serde(default)]
    args: Vec<String>,
    #[serde(default)]
    env: BTreeMap<String, String>,
    #[serde(default)]
    url: Option<String>,
    #[serde(default)]
    headers: BTreeMap<String, String>,
    #[serde(default)]
    disabled: Option<bool>,
    #[serde(default)]
    trusted: Option<bool>,
    /// 授予信任时该条目 command/url/env/headers 的指纹。
    /// 配置被改动后指纹对不上，旧的信任自动失效。
    #[serde(default)]
    trusted_fingerprint: Option<String>,
}

enum TransportKind {
    Stdio,
    Http(String),
}

impl McpServerEntry {
    fn transport(&self) -> Result<TransportKind, String> {
        if let Some(url) = self
            .url
            .as_deref()
            .map(str::trim)
            .filter(|url| !url.is_empty())
        {
            return Ok(TransportKind::Http(url.to_string()));
        }
        if self
            .command
            .as_deref()
            .map(str::trim)
            .is_some_and(|command| !command.is_empty())
        {
            return Ok(TransportKind::Stdio);
        }
        Err("条目缺少 command 或 url".to_string())
    }

    fn is_disabled(&self) -> bool {
        self.disabled.unwrap_or(false)
    }

    /// 决定「这台服务器到底会启动什么」的字段指纹。
    /// 信任必须绑定到这份指纹，改过 command/url/env/headers 就要重新确认。
    fn fingerprint(&self) -> String {
        let mut hasher = Sha256::new();
        hasher.update(b"command\0");
        hasher.update(self.command.as_deref().unwrap_or("").trim().as_bytes());
        for arg in &self.args {
            hasher.update(b"\0arg\0");
            hasher.update(arg.as_bytes());
        }
        for (key, value) in &self.env {
            hasher.update(b"\0env\0");
            hasher.update(key.as_bytes());
            hasher.update(b"\0");
            hasher.update(value.as_bytes());
        }
        hasher.update(b"\0url\0");
        hasher.update(self.url.as_deref().unwrap_or("").trim().as_bytes());
        for (name, value) in &self.headers {
            hasher.update(b"\0header\0");
            hasher.update(name.to_ascii_lowercase().as_bytes());
            hasher.update(b"\0");
            hasher.update(value.as_bytes());
        }
        format!("{:x}", hasher.finalize())
    }

    /// `mcp.json` 里的 `trusted` 只有在指纹仍然匹配时才算数。
    fn is_trusted(&self) -> bool {
        if !self.trusted.unwrap_or(false) {
            return false;
        }
        let fingerprint = self.fingerprint();
        self.trusted_fingerprint.as_deref() == Some(fingerprint.as_str())
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct McpToolInfo {
    /// 服务器原始工具名，调用时原样回传。
    pub(crate) name: String,
    pub(crate) title: Option<String>,
    pub(crate) description: String,
    pub(crate) input_schema: Value,
    /// 服务器的 `readOnlyHint`；只是提示，是否自动批准由前端结合 trusted 决定。
    pub(crate) read_only: bool,
}

impl From<Tool> for McpToolInfo {
    fn from(tool: Tool) -> Self {
        Self {
            name: tool.name.to_string(),
            title: tool.title,
            description: tool
                .description
                .map(|text| text.to_string())
                .unwrap_or_default(),
            input_schema: Value::Object((*tool.input_schema).clone()),
            read_only: tool
                .annotations
                .as_ref()
                .and_then(|annotations| annotations.read_only_hint)
                .unwrap_or(false),
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct McpServerTools {
    pub(crate) server_id: String,
    pub(crate) trusted: bool,
    pub(crate) tools: Vec<McpToolInfo>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct McpServerStatus {
    pub(crate) id: String,
    /// `stdio` | `http` | `invalid`
    pub(crate) transport: String,
    pub(crate) command: Option<String>,
    pub(crate) url: Option<String>,
    pub(crate) disabled: bool,
    pub(crate) trusted: bool,
    pub(crate) connected: bool,
    pub(crate) tool_count: usize,
    pub(crate) error: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct McpConfigView {
    pub(crate) path: String,
    pub(crate) text: String,
    /// 配置无法解析时的原因；此时 `servers` 为空，但原文仍会返回给用户修正。
    pub(crate) parse_error: Option<String>,
    pub(crate) servers: Vec<McpServerStatus>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct McpHealthResult {
    pub(crate) id: String,
    pub(crate) connected: bool,
    pub(crate) tool_count: usize,
    pub(crate) error: Option<String>,
}

/// 一个可导入的本地 MCP 配置来源。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct McpImportSource {
    /// `claude` | `cursor` | `workspace`，导入时原样回传。
    pub(crate) kind: String,
    pub(crate) label: String,
    pub(crate) path: String,
    pub(crate) exists: bool,
    /// 文件存在且可解析时的服务器名；解析失败时为空。
    pub(crate) servers: Vec<String>,
    pub(crate) error: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct McpImportResult {
    /// 真正写入本地配置的服务器（覆盖已有条目时也包含在内）。
    pub(crate) imported: Vec<String>,
    /// 同名条目，默认保留本地版本而未覆盖。
    pub(crate) skipped: Vec<String>,
    /// 来源与本地同名的全部条目，供 UI 提示冲突。
    pub(crate) conflicts: Vec<String>,
    /// 缺少 command/url 等无法导入的条目。
    pub(crate) invalid: Vec<String>,
    pub(crate) config: McpConfigView,
}

struct Connection {
    service: Arc<RunningService<RoleClient, ClientConfig>>,
    tools: Vec<McpToolInfo>,
    /// 建立连接时对应的配置指纹；配置变动后旧连接必须断开。
    fingerprint: String,
}

struct ActiveCall {
    server_id: String,
    abort: AbortHandle,
}

/// 进行中的 MCP 调用与提前到达的取消请求。
#[derive(Default)]
struct CallRegistry {
    active: HashMap<String, ActiveCall>,
    cancelled: VecDeque<String>,
}

impl CallRegistry {
    /// 注册调用；返回 `true` 表示这个 callId 在注册前已经被取消。
    fn register(&mut self, call_id: &str, server_id: &str, abort: AbortHandle) -> bool {
        if self.cancelled.contains(&call_id.to_string()) {
            return true;
        }
        if let Some(previous) = self.active.insert(
            call_id.to_string(),
            ActiveCall {
                server_id: server_id.to_string(),
                abort,
            },
        ) {
            // 同一个 callId 重复注册（前端不应发生）：旧任务不能继续跑。
            previous.abort.abort();
        }
        false
    }

    /// 取消单个调用；返回是否真的中止了一个正在等待的任务。
    fn cancel(&mut self, call_id: &str) -> bool {
        if let Some(call) = self.active.remove(call_id) {
            call.abort.abort();
            self.remember(call_id);
            true
        } else {
            self.remember(call_id);
            false
        }
    }

    fn finish(&mut self, call_id: &str) {
        self.active.remove(call_id);
    }

    /// 断开某个服务器时，先中止它名下的所有调用，避免取消整个连接时任务悬挂。
    fn abort_server(&mut self, server_id: &str) {
        let ids: Vec<String> = self
            .active
            .iter()
            .filter(|(_, call)| call.server_id == server_id)
            .map(|(id, _)| id.clone())
            .collect();
        for id in ids {
            if let Some(call) = self.active.remove(&id) {
                call.abort.abort();
            }
        }
    }

    fn remember(&mut self, call_id: &str) {
        if self.cancelled.iter().any(|id| id == call_id) {
            return;
        }
        self.cancelled.push_back(call_id.to_string());
        while self.cancelled.len() > MAX_CANCELLED_CALLS {
            self.cancelled.pop_front();
        }
    }
}

#[derive(Default)]
pub(crate) struct McpManager {
    connections: Mutex<HashMap<String, Arc<Connection>>>,
    errors: Mutex<HashMap<String, String>>,
    /// 每服务器一把建连锁：一个慢服务器不会阻塞其它服务器。
    connect_locks: Mutex<HashMap<String, Arc<Mutex<()>>>>,
    /// 连接失败后的冷却截止时间。
    cooldowns: Mutex<HashMap<String, Instant>>,
    calls: Mutex<CallRegistry>,
}

fn mcp_config_path<R: Runtime>(app: &AppHandle<R>) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|error| format!("定位应用数据目录失败：{error}"))?;
    fs::create_dir_all(&dir).map_err(|error| format!("创建应用数据目录失败：{error}"))?;
    Ok(dir.join(MCP_FILE_NAME))
}

fn read_config_text<R: Runtime>(app: &AppHandle<R>) -> Result<(PathBuf, String), String> {
    let path = mcp_config_path(app)?;
    match fs::read_to_string(&path) {
        Ok(text) => Ok((path, text)),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            Ok((path, DEFAULT_CONFIG_TEXT.to_string()))
        }
        Err(error) => Err(format!("读取 mcp.json 失败：{error}")),
    }
}

fn parse_config(text: &str) -> Result<McpFile, String> {
    let trimmed = text.trim();
    if trimmed.is_empty() {
        return Ok(McpFile::default());
    }
    let value: Value = serde_json::from_str(trimmed)
        .map_err(|error| format!("mcp.json 不是合法 JSON：{error}"))?;
    if !value.is_object() {
        return Err("mcp.json 顶层必须是对象".to_string());
    }
    serde_json::from_value(value).map_err(|error| format!("mcp.json 结构不正确：{error}"))
}

fn write_config_text<R: Runtime>(app: &AppHandle<R>, text: &str) -> Result<PathBuf, String> {
    let path = mcp_config_path(app)?;
    // 复用统一实现：Windows 上 rename 覆盖已存在的文件会失败，
    // `write_file_atomically` 会先删除目标再换名。
    crate::file_system::write_file_atomically(&path, text.as_bytes())
        .map_err(|error| format!("保存 mcp.json 失败：{error}"))?;
    Ok(path)
}

/// callId 只接受 1–64 个 `[A-Za-z0-9_-]` 字符；调用方负责生成唯一值。
fn is_valid_call_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= MAX_CALL_ID_LENGTH
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'-')
}

fn home_dir() -> Option<PathBuf> {
    #[cfg(windows)]
    let variable = "USERPROFILE";
    #[cfg(not(windows))]
    let variable = "HOME";
    std::env::var_os(variable)
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
}

fn claude_config_path() -> Option<PathBuf> {
    #[cfg(windows)]
    {
        std::env::var_os("APPDATA")
            .filter(|value| !value.is_empty())
            .map(PathBuf::from)
            .map(|dir| dir.join("Claude").join("claude_desktop_config.json"))
    }
    #[cfg(target_os = "macos")]
    {
        home_dir().map(|home| {
            home.join("Library/Application Support/Claude/claude_desktop_config.json")
        })
    }
    #[cfg(all(not(windows), not(target_os = "macos")))]
    {
        home_dir().map(|home| home.join(".config/Claude/claude_desktop_config.json"))
    }
}

/// 解析一个已知来源；路径本身可以不存在（扫描时报告 exists: false）。
fn resolve_import_source(
    kind: &str,
    workspace_root: Option<&str>,
) -> Result<(&'static str, PathBuf), String> {
    match kind {
        "claude" => claude_config_path()
            .map(|path| ("Claude Desktop", path))
            .ok_or_else(|| "无法定位 Claude Desktop 配置目录".to_string()),
        "cursor" => home_dir()
            .map(|home| ("Cursor", home.join(".cursor").join("mcp.json")))
            .ok_or_else(|| "无法定位用户主目录".to_string()),
        "workspace" => {
            let root = workspace_root
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .ok_or_else(|| "未打开工作区，无法读取 .mcp.json".to_string())?;
            let root = fs::canonicalize(root).map_err(|error| format!("定位工作区失败：{error}"))?;
            if !root.is_dir() {
                return Err("工作区根不是目录".to_string());
            }
            Ok(("工作区", root.join(".mcp.json")))
        }
        _ => Err(format!("未知的 MCP 配置来源「{kind}」")),
    }
}

/// 读取来源文件里的 `mcpServers` 原始条目；未知字段原样保留。
fn read_import_servers(path: &Path) -> Result<BTreeMap<String, Value>, String> {
    let text = fs::read_to_string(path)
        .map_err(|error| format!("读取 {} 失败：{error}", path.display()))?;
    let value: Value = serde_json::from_str(&text)
        .map_err(|error| format!("{} 不是合法 JSON：{error}", path.display()))?;
    let servers = value
        .get("mcpServers")
        .and_then(Value::as_object)
        .ok_or_else(|| format!("{} 缺少 mcpServers 对象", path.display()))?;
    Ok(servers
        .iter()
        .map(|(id, entry)| (id.clone(), entry.clone()))
        .collect())
}

fn scan_source(kind: &str, workspace_root: Option<&str>) -> McpImportSource {
    match resolve_import_source(kind, workspace_root) {
        Ok((label, path)) => {
            let exists = path.is_file();
            let (servers, error) = if exists {
                match read_import_servers(&path) {
                    Ok(entries) => (entries.keys().cloned().collect(), None),
                    Err(error) => (Vec::new(), Some(error)),
                }
            } else {
                (Vec::new(), None)
            };
            McpImportSource {
                kind: kind.to_string(),
                label: label.to_string(),
                path: path.display().to_string(),
                exists,
                servers,
                error,
            }
        }
        Err(error) => McpImportSource {
            kind: kind.to_string(),
            label: kind.to_string(),
            path: String::new(),
            exists: false,
            servers: Vec::new(),
            error: Some(error),
        },
    }
}

#[derive(Default)]
struct ImportCounts {
    imported: Vec<String>,
    skipped: Vec<String>,
    conflicts: Vec<String>,
    invalid: Vec<String>,
}

/// 把来源条目合并进本地配置。
///
/// - 默认只补新增，同名条目保留本地版本；
/// - `replace_existing` 时覆盖同名条目，但仍记录在 `conflicts` 里；
/// - 导入条目的 `trusted` 一律重置为 `false`，并删除旧指纹；
/// - 条目按原始 `Value` 复制，未知字段不会丢失。
fn merge_import(
    target: &mut Value,
    source: &BTreeMap<String, Value>,
    replace_existing: bool,
) -> Result<ImportCounts, String> {
    let root = target
        .as_object_mut()
        .ok_or_else(|| "mcp.json 顶层必须是对象".to_string())?;
    let servers = root
        .entry("mcpServers".to_string())
        .or_insert_with(|| Value::Object(Default::default()));
    let servers = servers
        .as_object_mut()
        .ok_or_else(|| "mcp.json 缺少 mcpServers 对象".to_string())?;

    let mut counts = ImportCounts::default();
    for (name, raw) in source {
        let parsed: McpServerEntry = match serde_json::from_value(raw.clone()) {
            Ok(parsed) => parsed,
            Err(_) => {
                counts.invalid.push(name.clone());
                continue;
            }
        };
        if parsed.transport().is_err() {
            counts.invalid.push(name.clone());
            continue;
        }
        if servers.contains_key(name) {
            counts.conflicts.push(name.clone());
            if !replace_existing {
                counts.skipped.push(name.clone());
                continue;
            }
        }
        let mut entry = raw.as_object().cloned().unwrap_or_default();
        // 导入不等于信任：每个条目都必须由用户在设置页显式确认。
        entry.insert("trusted".to_string(), Value::Bool(false));
        entry.remove("trustedFingerprint");
        servers.insert(name.clone(), Value::Object(entry));
        counts.imported.push(name.clone());
    }
    Ok(counts)
}

fn client_config() -> ClientConfig {
    ClientConfig::new(
        ClientCapabilities::default(),
        Implementation::new("nomo", env!("CARGO_PKG_VERSION")),
    )
}

async fn connect_stdio(
    entry: &McpServerEntry,
) -> Result<RunningService<RoleClient, ClientConfig>, String> {
    let command = entry
        .command
        .as_deref()
        .map(str::trim)
        .filter(|command| !command.is_empty())
        .ok_or_else(|| "配置缺少 command".to_string())?;
    let cmd = build_command(command, &entry.args, &entry.env);
    let transport =
        TokioChildProcess::new(cmd).map_err(|error| format!("启动 MCP 子进程失败：{error}"))?;
    let serve = client_config().serve(transport);
    match tokio::time::timeout(CONNECT_TIMEOUT, serve).await {
        Ok(Ok(service)) => Ok(service),
        Ok(Err(error)) => Err(format!("连接 MCP 服务器失败：{error}")),
        Err(_) => Err("连接 MCP 服务器超时".to_string()),
    }
}

async fn connect_http(
    url: &str,
    headers: &BTreeMap<String, String>,
) -> Result<RunningService<RoleClient, ClientConfig>, String> {
    let mut custom_headers = HashMap::new();
    for (name, value) in headers {
        let name = reqwest::header::HeaderName::from_bytes(name.as_bytes())
            .map_err(|error| format!("HTTP 头名称不合法（{name}）：{error}"))?;
        let value = reqwest::header::HeaderValue::from_str(value)
            .map_err(|error| format!("HTTP 头内容不合法（{name}）：{error}"))?;
        custom_headers.insert(name, value);
    }
    let config = StreamableHttpClientTransportConfig::with_uri(url.to_string())
        .custom_headers(custom_headers);
    let transport = StreamableHttpClientTransport::with_client(reqwest::Client::new(), config);
    let serve = client_config().serve(transport);
    match tokio::time::timeout(CONNECT_TIMEOUT, serve).await {
        Ok(Ok(service)) => Ok(service),
        Ok(Err(error)) => Err(format!("连接 MCP 服务器失败：{error}")),
        Err(_) => Err("连接 MCP 服务器超时".to_string()),
    }
}

/// Windows 上 `npx` / `pnpm` 这类命令是 `.cmd`，CreateProcess 直接找不到，
/// 需要交给 `cmd /C`；仍然加 `CREATE_NO_WINDOW`，避免弹出黑框。
fn build_command(command: &str, args: &[String], env: &BTreeMap<String, String>) -> CommandWrap {
    #[cfg(windows)]
    let (program, prefix): (String, Vec<String>) = if needs_cmd_shell(command) {
        (
            "cmd".to_string(),
            vec!["/C".to_string(), command.to_string()],
        )
    } else {
        (command.to_string(), Vec::new())
    };
    #[cfg(not(windows))]
    let (program, prefix): (String, Vec<String>) = (command.to_string(), Vec::new());

    let mut wrap = CommandWrap::with_new(&program, |cmd| {
        cmd.args(prefix.iter());
        cmd.args(args.iter());
        for (key, value) in env {
            cmd.env(key, value);
        }
    });

    // Job Object：Nomo 退出时由系统结束整棵子进程树，避免留下孤儿 MCP 进程。
    // CreationFlags 和 JobObject 必须配合使用，否则 CREATE_NO_WINDOW 会被后者覆盖。
    #[cfg(windows)]
    {
        use windows::Win32::System::Threading::PROCESS_CREATION_FLAGS;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        wrap.wrap(CreationFlags(PROCESS_CREATION_FLAGS(CREATE_NO_WINDOW)));
        wrap.wrap(JobObject);
    }

    wrap
}

#[cfg(windows)]
fn needs_cmd_shell(command: &str) -> bool {
    // 明确的可执行文件直接启动；其余短名（python、npx、node……）交给 cmd 解析 PATHEXT。
    let lower = command.to_ascii_lowercase();
    if lower.ends_with(".exe") {
        return false;
    }
    !(command.contains('/') || command.contains('\\'))
}

async fn list_all_tools(
    service: &RunningService<RoleClient, ClientConfig>,
) -> Result<Vec<McpToolInfo>, String> {
    let mut tools = Vec::new();
    let mut cursor: Option<String> = None;
    for _ in 0..MAX_TOOL_PAGES {
        let mut params = PaginatedRequestParams::default();
        params.cursor = cursor.clone();
        let page = tokio::time::timeout(LIST_TOOLS_TIMEOUT, service.list_tools(Some(params)))
            .await
            .map_err(|_| "读取工具列表超时".to_string())?
            .map_err(|error| format!("读取工具列表失败：{error}"))?;
        tools.extend(page.tools.into_iter().map(McpToolInfo::from));
        cursor = page.next_cursor;
        if cursor.is_none() {
            break;
        }
    }
    Ok(tools)
}

async fn connect_server(
    entry: &McpServerEntry,
) -> Result<(RunningService<RoleClient, ClientConfig>, Vec<McpToolInfo>), String> {
    let service = match entry.transport()? {
        TransportKind::Stdio => connect_stdio(entry).await?,
        TransportKind::Http(url) => connect_http(&url, &entry.headers).await?,
    };
    match list_all_tools(&service).await {
        Ok(tools) => Ok((service, tools)),
        Err(error) => {
            service.cancellation_token().cancel();
            Err(error)
        }
    }
}

impl McpManager {
    /// 建立或复用连接。
    ///
    /// `force` 用于用户显式操作（点「连接」/健康检查）：绕过失败冷却。
    /// 自动路径（对话中的工具调用）在 30 秒冷却内直接返回上次的错误，
    /// 避免模型反复拉起一个坏服务器。
    async fn ensure_connection(
        &self,
        id: &str,
        entry: &McpServerEntry,
        force: bool,
    ) -> Result<Arc<Connection>, String> {
        let fingerprint = entry.fingerprint();
        {
            let connections = self.connections.lock().await;
            if let Some(existing) = connections.get(id) {
                if !existing.service.is_closed() && existing.fingerprint == fingerprint {
                    return Ok(existing.clone());
                }
            }
        }

        // 每服务器一把建连锁：慢服务器只阻塞自己，不拖住其它服务器。
        let lock = self
            .connect_locks
            .lock()
            .await
            .entry(id.to_string())
            .or_insert_with(|| Arc::new(Mutex::new(())))
            .clone();
        let _guard = lock.lock().await;

        // 等锁期间可能已经有别的调用建好连接，再检查一次。
        let stale = {
            let mut connections = self.connections.lock().await;
            if let Some(existing) = connections.get(id) {
                if !existing.service.is_closed() && existing.fingerprint == fingerprint {
                    return Ok(existing.clone());
                }
            }
            connections.remove(id)
        };
        if let Some(stale) = stale {
            stale.service.cancellation_token().cancel();
        }

        if !force {
            let cooldown = *self.cooldowns.lock().await.get(id).unwrap_or(&Instant::now());
            if cooldown > Instant::now() {
                let previous = self.errors.lock().await.get(id).cloned();
                return Err(match previous {
                    Some(error) => format!("{error}（{FAILURE_COOLDOWN:?}内不会自动重试）"),
                    None => "该服务器刚刚连接失败，稍后再试".to_string(),
                });
            }
        }

        match connect_server(entry).await {
            Ok((service, tools)) => {
                let connection = Arc::new(Connection {
                    service: Arc::new(service),
                    tools,
                    fingerprint,
                });
                self.connections
                    .lock()
                    .await
                    .insert(id.to_string(), connection.clone());
                self.errors.lock().await.remove(id);
                self.cooldowns.lock().await.remove(id);
                Ok(connection)
            }
            Err(error) => {
                self.errors
                    .lock()
                    .await
                    .insert(id.to_string(), error.clone());
                self.cooldowns
                    .lock()
                    .await
                    .insert(id.to_string(), Instant::now() + FAILURE_COOLDOWN);
                Err(error)
            }
        }
    }

    async fn disconnect(&self, id: &str) {
        // 先中止该服务器名下正在等待的调用，再关整条连接。
        self.calls.lock().await.abort_server(id);
        let connection = self.connections.lock().await.remove(id);
        if let Some(connection) = connection {
            connection.service.cancellation_token().cancel();
        }
        self.errors.lock().await.remove(id);
        self.cooldowns.lock().await.remove(id);
    }

    /// 注册一个进行中的调用；返回 `true` 表示该 callId 已被提前取消。
    async fn track_call(&self, call_id: &str, server_id: &str, abort: AbortHandle) -> bool {
        self.calls
            .lock()
            .await
            .register(call_id, server_id, abort)
    }

    async fn finish_call(&self, call_id: &str) {
        self.calls.lock().await.finish(call_id);
    }

    async fn cancel_call(&self, call_id: &str) -> bool {
        self.calls.lock().await.cancel(call_id)
    }

    /// 用一次 `tools/list` 探活；成功时顺手刷新缓存里的工具清单。
    async fn check_health(
        &self,
        id: &str,
        entry: &McpServerEntry,
        force_reconnect: bool,
    ) -> McpHealthResult {
        let failed = |error: String| McpHealthResult {
            id: id.to_string(),
            connected: false,
            tool_count: 0,
            error: Some(error),
        };

        if entry.is_disabled() {
            return failed("该服务器已被禁用".to_string());
        }
        if force_reconnect {
            self.disconnect(id).await;
        }

        let existing = {
            let connections = self.connections.lock().await;
            connections
                .get(id)
                .filter(|connection| {
                    !connection.service.is_closed() && connection.fingerprint == entry.fingerprint()
                })
                .cloned()
        };

        if let Some(connection) = existing {
            match tokio::time::timeout(HEALTH_TIMEOUT, list_all_tools(&connection.service)).await {
                Ok(Ok(tools)) => {
                    let count = tools.len();
                    let mut connections = self.connections.lock().await;
                    if let Some(current) = connections.get(id) {
                        if Arc::ptr_eq(current, &connection) {
                            connections.insert(
                                id.to_string(),
                                Arc::new(Connection {
                                    service: connection.service.clone(),
                                    tools,
                                    fingerprint: connection.fingerprint.clone(),
                                }),
                            );
                        }
                    }
                    drop(connections);
                    self.errors.lock().await.remove(id);
                    return McpHealthResult {
                        id: id.to_string(),
                        connected: true,
                        tool_count: count,
                        error: None,
                    };
                }
                Ok(Err(error)) => {
                    self.disconnect(id).await;
                    self.errors
                        .lock()
                        .await
                        .insert(id.to_string(), format!("健康检查失败：{error}"));
                }
                Err(_) => {
                    self.disconnect(id).await;
                    self.errors
                        .lock()
                        .await
                        .insert(id.to_string(), "健康检查超时".to_string());
                }
            }
        }

        // 未连接（或探活失败后已断开）：显式健康检查允许重连。
        match self.ensure_connection(id, entry, true).await {
            Ok(connection) => McpHealthResult {
                id: id.to_string(),
                connected: true,
                tool_count: connection.tools.len(),
                error: None,
            },
            Err(error) => failed(error),
        }
    }

    async fn statuses(&self, file: &McpFile) -> Vec<McpServerStatus> {
        let connections = self.connections.lock().await;
        let errors = self.errors.lock().await;
        file.mcp_servers
            .iter()
            .map(|(id, entry)| {
                let transport = match entry.transport() {
                    Ok(TransportKind::Stdio) => "stdio",
                    Ok(TransportKind::Http(_)) => "http",
                    Err(_) => "invalid",
                };
                let live = connections
                    .get(id)
                    .filter(|connection| !connection.service.is_closed());
                McpServerStatus {
                    id: id.clone(),
                    transport: transport.to_string(),
                    command: entry.command.clone(),
                    url: entry.url.clone(),
                    disabled: entry.is_disabled(),
                    trusted: entry.is_trusted(),
                    connected: live.is_some(),
                    tool_count: live.map(|connection| connection.tools.len()).unwrap_or(0),
                    error: errors.get(id).cloned(),
                }
            })
            .collect()
    }
}

async fn config_view<R: Runtime>(
    app: &AppHandle<R>,
    manager: &McpManager,
) -> Result<McpConfigView, String> {
    let (path, text) = read_config_text(app)?;
    let (parse_error, servers) = match parse_config(&text) {
        Ok(file) => (None, manager.statuses(&file).await),
        Err(error) => (Some(error), Vec::new()),
    };
    Ok(McpConfigView {
        path: path.display().to_string(),
        text,
        parse_error,
        servers,
    })
}

/// 条目被删除、禁用，或者 command/url/env/headers 变了：旧进程必须断开。
async fn disconnect_stale_servers(manager: &McpManager, file: &McpFile) {
    let stale: Vec<String> = {
        let connections = manager.connections.lock().await;
        connections
            .iter()
            .filter(|(id, connection)| match file.mcp_servers.get(id.as_str()) {
                None => true,
                Some(entry) => {
                    entry.is_disabled()
                        || entry.transport().is_err()
                        || entry.fingerprint() != connection.fingerprint
                }
            })
            .map(|(id, _)| id.clone())
            .collect()
    };
    for id in stale {
        manager.disconnect(&id).await;
    }
}

#[tauri::command]
pub(crate) async fn assistant_mcp_config_read(
    app: AppHandle,
    manager: State<'_, McpManager>,
) -> Result<McpConfigView, String> {
    config_view(&app, &manager).await
}

#[tauri::command]
pub(crate) async fn assistant_mcp_config_write(
    app: AppHandle,
    manager: State<'_, McpManager>,
    text: String,
) -> Result<McpConfigView, String> {
    // 先校验再落盘：坏配置不覆盖用户原文件。
    let file = parse_config(&text)?;
    write_config_text(&app, &text)?;
    disconnect_stale_servers(&manager, &file).await;
    config_view(&app, &manager).await
}

/// 只改 `trusted` 开关：按 `serde_json::Value` 改写，保留配置里的其它字段。
#[tauri::command]
pub(crate) async fn assistant_mcp_set_trusted(
    app: AppHandle,
    manager: State<'_, McpManager>,
    id: String,
    trusted: bool,
) -> Result<McpConfigView, String> {
    let (_, text) = read_config_text(&app)?;
    let mut value: Value = if text.trim().is_empty() {
        serde_json::json!({ "mcpServers": {} })
    } else {
        serde_json::from_str(&text).map_err(|error| format!("mcp.json 不是合法 JSON：{error}"))?
    };
    let servers = value
        .get_mut("mcpServers")
        .and_then(Value::as_object_mut)
        .ok_or_else(|| "mcp.json 缺少 mcpServers 对象".to_string())?;
    let entry = servers
        .get_mut(&id)
        .and_then(Value::as_object_mut)
        .ok_or_else(|| format!("mcp.json 中找不到服务器「{id}」"))?;
    entry.insert("trusted".to_string(), Value::Bool(trusted));
    // 信任绑定到当前配置指纹；之后改动 command/url/env/headers 就不再算可信。
    if trusted {
        let parsed: McpServerEntry = serde_json::from_value(Value::Object(entry.clone()))
            .map_err(|error| format!("解析服务器「{id}」配置失败：{error}"))?;
        entry.insert(
            "trustedFingerprint".to_string(),
            Value::String(parsed.fingerprint()),
        );
    } else {
        entry.remove("trustedFingerprint");
    }

    let mut next = serde_json::to_string_pretty(&value)
        .map_err(|error| format!("序列化 mcp.json 失败：{error}"))?;
    next.push('\n');
    write_config_text(&app, &next)?;
    config_view(&app, &manager).await
}

#[tauri::command]
pub(crate) async fn assistant_mcp_connect(
    app: AppHandle,
    manager: State<'_, McpManager>,
    id: String,
) -> Result<Vec<McpToolInfo>, String> {
    let (_, text) = read_config_text(&app)?;
    let file = parse_config(&text)?;
    let entry = file
        .mcp_servers
        .get(&id)
        .ok_or_else(|| format!("mcp.json 中找不到服务器「{id}」"))?;
    if entry.is_disabled() {
        return Err(format!("MCP 服务器「{id}」已被禁用"));
    }
    // 用户显式点「连接」：绕过失败冷却。
    let connection = manager.ensure_connection(&id, entry, true).await?;
    Ok(connection.tools.clone())
}

#[tauri::command]
pub(crate) async fn assistant_mcp_disconnect(
    manager: State<'_, McpManager>,
    id: String,
) -> Result<(), String> {
    manager.disconnect(&id).await;
    Ok(())
}

/// 供发起对话时收集工具：只返回本次会话里用户显式点过「连接」、且仍然存活的服务器。
/// 未连接的服务器不会进入工具表，也不会因为一次对话被悄悄启动。
#[tauri::command]
pub(crate) async fn assistant_mcp_tools(
    app: AppHandle,
    manager: State<'_, McpManager>,
) -> Result<Vec<McpServerTools>, String> {
    let (_, text) = read_config_text(&app)?;
    let file = parse_config(&text)?;
    let connections = manager.connections.lock().await;
    let mut servers = Vec::new();
    for (id, connection) in connections.iter() {
        if connection.service.is_closed() {
            continue;
        }
        let Some(entry) = file.mcp_servers.get(id) else {
            continue;
        };
        if entry.is_disabled()
            || entry.transport().is_err()
            || entry.fingerprint() != connection.fingerprint
        {
            continue;
        }
        servers.push(McpServerTools {
            server_id: id.clone(),
            trusted: entry.is_trusted(),
            tools: connection.tools.clone(),
        });
    }
    Ok(servers)
}

/// 调用一个 MCP 工具。
///
/// 调用跑在独立任务里，`callId` 用于 `assistant_mcp_call_cancel` 精确中止这一次调用；
/// **不会**取消整条连接（复用连接上可能还有并发调用）。
#[tauri::command]
pub(crate) async fn assistant_mcp_call(
    app: AppHandle,
    manager: State<'_, McpManager>,
    server_id: String,
    tool: String,
    arguments: Option<Value>,
    call_id: String,
) -> Result<Value, String> {
    if !is_valid_call_id(&call_id) {
        return Err("callId 只能包含字母、数字、下划线和短横线，长度 1–64".to_string());
    }
    let (_, text) = read_config_text(&app)?;
    let file = parse_config(&text)?;
    let entry = file
        .mcp_servers
        .get(&server_id)
        .ok_or_else(|| format!("mcp.json 中找不到服务器「{server_id}」"))?;
    if entry.is_disabled() {
        return Err(format!("MCP 服务器「{server_id}」已被禁用"));
    }
    let connection = manager.ensure_connection(&server_id, entry, false).await?;

    let arguments: Option<JsonObject> = match arguments {
        None | Some(Value::Null) => None,
        Some(Value::Object(map)) => Some(map),
        Some(_) => return Err("MCP 工具参数必须是 JSON 对象".to_string()),
    };
    let mut params = CallToolRequestParams::default();
    params.name = tool.clone().into();
    params.arguments = arguments;

    let service = connection.service.clone();
    let tool_for_task = tool.clone();
    let task = tokio::spawn(async move {
        tokio::time::timeout(CALL_TIMEOUT, service.call_tool(params)).await
    });
    if manager
        .track_call(&call_id, &server_id, task.abort_handle())
        .await
    {
        // 取消早于注册：不再等这次调用。
        task.abort();
        return Err(format!("MCP 工具「{tool_for_task}」调用已取消"));
    }

    let outcome = task.await;
    manager.finish_call(&call_id).await;
    let value = match outcome {
        Ok(Ok(Ok(result))) => {
            serde_json::to_value(result).map_err(|error| format!("序列化 MCP 结果失败：{error}"))?
        }
        Ok(Ok(Err(error))) => {
            return Err(format!("MCP 工具「{tool}」调用失败：{error}"));
        }
        Ok(Err(_)) => return Err(format!("MCP 工具「{tool}」调用超时")),
        Err(error) if error.is_cancelled() => {
            return Err(format!("MCP 工具「{tool}」调用已取消"));
        }
        Err(error) => return Err(format!("MCP 工具「{tool}」调用失败：{error}")),
    };
    Ok(clamp_result(value))
}

/// 只中止指定 callId 的调用；重复取消是幂等的。
/// 前端监听 abortSignal 后调用这里，进行中的 MCP 请求会收到 `notifications/cancelled`。
#[tauri::command]
pub(crate) async fn assistant_mcp_call_cancel(
    manager: State<'_, McpManager>,
    call_id: String,
) -> Result<bool, String> {
    if !is_valid_call_id(&call_id) {
        return Err("callId 只能包含字母、数字、下划线和短横线，长度 1–64".to_string());
    }
    Ok(manager.cancel_call(&call_id).await)
}

/// 健康检查：带 `id` 时检查（必要时重连）该服务器；不带 `id` 时只探活已连接服务器。
/// 显式检查会绕过 30 秒失败冷却。
#[tauri::command]
pub(crate) async fn assistant_mcp_health(
    app: AppHandle,
    manager: State<'_, McpManager>,
    id: Option<String>,
    force: Option<bool>,
) -> Result<Vec<McpHealthResult>, String> {
    let (_, text) = read_config_text(&app)?;
    let file = parse_config(&text)?;
    let force = force.unwrap_or(false);

    if let Some(id) = id {
        let entry = file
            .mcp_servers
            .get(&id)
            .ok_or_else(|| format!("mcp.json 中找不到服务器「{id}」"))?;
        return Ok(vec![manager.check_health(&id, entry, force).await]);
    }

    let live: Vec<(String, McpServerEntry)> = {
        let connections = manager.connections.lock().await;
        connections
            .keys()
            .filter_map(|id| {
                file.mcp_servers
                    .get(id)
                    .map(|entry| (id.clone(), entry.clone()))
            })
            .collect()
    };
    let mut results = Vec::new();
    for (id, entry) in live {
        results.push(manager.check_health(&id, &entry, false).await);
    }
    Ok(results)
}

/// 扫描常见客户端的 MCP 配置；工作区 `.mcp.json` 只在传入工作区根时检查。
#[tauri::command]
pub(crate) async fn assistant_mcp_import_scan(
    workspace_root: Option<String>,
) -> Result<Vec<McpImportSource>, String> {
    let mut sources = vec![
        scan_source("claude", None),
        scan_source("cursor", None),
    ];
    if workspace_root
        .as_deref()
        .map(str::trim)
        .is_some_and(|value| !value.is_empty())
    {
        sources.push(scan_source("workspace", workspace_root.as_deref()));
    }
    Ok(sources)
}

/// 把某个来源的条目合并进本地 `mcp.json`。默认保留本地同名条目。
#[tauri::command]
pub(crate) async fn assistant_mcp_import(
    app: AppHandle,
    manager: State<'_, McpManager>,
    kind: String,
    workspace_root: Option<String>,
    replace_existing: Option<bool>,
) -> Result<McpImportResult, String> {
    let (_, path) = resolve_import_source(&kind, workspace_root.as_deref())?;
    if !path.is_file() {
        return Err(format!("配置文件不存在：{}", path.display()));
    }
    let source = read_import_servers(&path)?;

    let (_, text) = read_config_text(&app)?;
    let mut target: Value = if text.trim().is_empty() {
        serde_json::json!({ "mcpServers": {} })
    } else {
        serde_json::from_str(&text).map_err(|error| format!("mcp.json 不是合法 JSON：{error}"))?
    };
    let counts = merge_import(&mut target, &source, replace_existing.unwrap_or(false))?;

    let mut next = serde_json::to_string_pretty(&target)
        .map_err(|error| format!("序列化 mcp.json 失败：{error}"))?;
    next.push('\n');
    write_config_text(&app, &next)?;

    let file = parse_config(&next)?;
    disconnect_stale_servers(&manager, &file).await;

    audit::record(
        &app,
        "mcp_import",
        &[
            ("source", json!(kind)),
            ("workspaceRoot", json!(workspace_root.unwrap_or_default())),
            ("replaceExisting", json!(replace_existing.unwrap_or(false))),
            ("imported", json!(counts.imported)),
            ("skipped", json!(counts.skipped)),
            ("conflicts", json!(counts.conflicts)),
            ("invalid", json!(counts.invalid)),
        ],
    );

    Ok(McpImportResult {
        imported: counts.imported,
        skipped: counts.skipped,
        conflicts: counts.conflicts,
        invalid: counts.invalid,
        config: config_view(&app, &manager).await?,
    })
}

/// 超长结果在跨 IPC 之前就截断；返回字符串保证前端仍能展示开头部分。
fn clamp_result(value: Value) -> Value {
    let Ok(text) = serde_json::to_string(&value) else {
        return value;
    };
    if text.len() <= MAX_CALL_RESULT_BYTES {
        return value;
    }
    let mut end = MAX_CALL_RESULT_BYTES;
    while !text.is_char_boundary(end) {
        end -= 1;
    }
    Value::String(format!("{}\n…（MCP 结果已截断）", &text[..end]))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    #[test]
    fn parses_standard_stdio_and_http_entries() {
        let file = parse_config(
            r#"{
                "mcpServers": {
                    "word-operation": {
                        "command": "python",
                        "args": ["server.py"],
                        "env": { "MODE": "docx" }
                    },
                    "remote": {
                        "url": "http://127.0.0.1:3000/mcp",
                        "headers": { "Authorization": "Bearer token" },
                        "trusted": true
                    }
                }
            }"#,
        )
        .expect("配置应能解析");
        assert_eq!(file.mcp_servers.len(), 2);
        let local = &file.mcp_servers["word-operation"];
        assert!(matches!(local.transport(), Ok(TransportKind::Stdio)));
        assert!(!local.is_disabled());
        let remote = &file.mcp_servers["remote"];
        assert!(matches!(remote.transport(), Ok(TransportKind::Http(_))));
        assert!(remote.trusted.unwrap_or(false));
    }

    #[test]
    fn rejects_broken_json_and_entries_without_transport() {
        assert!(parse_config("{ not json").is_err());
        let file = parse_config(r#"{"mcpServers":{"bad":{}}}"#).unwrap();
        assert!(file.mcp_servers["bad"].transport().is_err());
    }

    #[test]
    fn treats_missing_servers_as_empty() {
        let file = parse_config("{}").unwrap();
        assert!(file.mcp_servers.is_empty());
        let file = parse_config("").unwrap();
        assert!(file.mcp_servers.is_empty());
    }

    fn entry(id: &str, command: &str) -> McpServerEntry {
        parse_config(&format!(
            r#"{{"mcpServers":{{"{id}":{{"command":"{command}"}}}}}}"#
        ))
        .unwrap()
        .mcp_servers
        .remove(id)
        .unwrap()
    }

    #[test]
    fn trust_requires_a_matching_fingerprint() {
        let mut server = entry("word-operation", "python");
        server.trusted = Some(true);
        // 只有 trusted:true、没有指纹（例如手写配置）时不自动放行。
        assert!(!server.is_trusted());

        server.trusted_fingerprint = Some(server.fingerprint());
        assert!(server.is_trusted());

        // 改掉 command 后指纹失配，旧的信任立即失效。
        server.command = Some("node".to_string());
        assert!(!server.is_trusted());

        // 指纹描述的是「这份配置」：改回原值后信任随之恢复。
        server.command = Some("python".to_string());
        assert!(server.is_trusted());
    }

    #[test]
    fn validates_call_ids() {
        assert!(is_valid_call_id("call-1_A"));
        assert!(is_valid_call_id(&"a".repeat(MAX_CALL_ID_LENGTH)));
        assert!(!is_valid_call_id(""));
        assert!(!is_valid_call_id(&"a".repeat(MAX_CALL_ID_LENGTH + 1)));
        assert!(!is_valid_call_id("含中文"));
        assert!(!is_valid_call_id("bad id"));
        assert!(!is_valid_call_id("bad/id"));
    }

    #[tokio::test]
    async fn call_registry_cancels_only_the_target_call() {
        let manager = McpManager::default();
        let first = tokio::spawn(async {
            tokio::time::sleep(Duration::from_secs(30)).await;
            1
        });
        let second = tokio::spawn(async {
            tokio::time::sleep(Duration::from_secs(30)).await;
            2
        });
        assert!(
            !manager
                .track_call("call-1", "server-a", first.abort_handle())
                .await
        );
        assert!(
            !manager
                .track_call("call-2", "server-b", second.abort_handle())
                .await
        );

        assert!(manager.cancel_call("call-1").await);
        assert!(first.await.unwrap_err().is_cancelled());
        // 重复取消是幂等的，不会 panic，也不影响另一个 call。
        assert!(!manager.cancel_call("call-1").await);

        manager.finish_call("call-1").await;
        manager.finish_call("call-2").await;
        second.abort();
        let _ = second.await;
    }

    #[tokio::test]
    async fn cancel_before_register_is_remembered_and_bounded() {
        let manager = McpManager::default();
        assert!(!manager.cancel_call("early-call").await);

        let task = tokio::spawn(async {
            tokio::time::sleep(Duration::from_secs(30)).await;
        });
        assert!(
            manager
                .track_call("early-call", "server", task.abort_handle())
                .await
        );
        task.abort();
        let _ = task.await;

        for index in 0..(MAX_CANCELLED_CALLS + 10) {
            manager.cancel_call(&format!("tomb-{index}")).await;
        }
        // 有界：不能因为持续取消而无限增长。
        assert!(manager.calls.lock().await.cancelled.len() <= MAX_CANCELLED_CALLS);
    }

    #[tokio::test]
    async fn aborting_a_server_only_stops_its_own_calls() {
        let manager = McpManager::default();
        let first = tokio::spawn(async {
            tokio::time::sleep(Duration::from_secs(30)).await;
        });
        let second = tokio::spawn(async {
            tokio::time::sleep(Duration::from_secs(30)).await;
        });
        manager
            .track_call("a-1", "server-a", first.abort_handle())
            .await;
        manager
            .track_call("b-1", "server-b", second.abort_handle())
            .await;

        manager.calls.lock().await.abort_server("server-a");
        assert!(first.await.unwrap_err().is_cancelled());
        assert!(!second.is_finished());

        second.abort();
        let _ = second.await;
    }

    #[tokio::test]
    async fn health_reports_disabled_servers_without_connecting() {
        let manager = McpManager::default();
        let mut server = entry("disabled", "python");
        server.disabled = Some(true);
        let result = manager.check_health("disabled", &server, false).await;
        assert!(!result.connected);
        assert_eq!(result.tool_count, 0);
        assert!(result.error.unwrap().contains("禁用"));
    }

    #[test]
    fn clamps_oversized_results_before_ipc() {
        let large = Value::String("字".repeat(MAX_CALL_RESULT_BYTES / 3 + 10));
        let clamped = clamp_result(large);
        let text = clamped.as_str().expect("超长结果应被转成字符串");
        assert!(text.len() <= MAX_CALL_RESULT_BYTES + 128);
        assert!(text.contains("已截断"));

        let small = Value::String("ok".to_string());
        assert_eq!(clamp_result(small.clone()), small);
    }

    #[test]
    fn import_keeps_local_entries_and_strips_trust() {
        let mut target = serde_json::json!({
            "mcpServers": { "local": { "command": "python" } },
            "unrelated": { "keep": true }
        });
        let source: BTreeMap<String, Value> = serde_json::from_value(serde_json::json!({
            "local": { "command": "node", "custom": 1, "trusted": true, "trustedFingerprint": "old" },
            "fresh": { "command": "npx", "args": ["-y", "srv"], "custom": 42, "trusted": true, "trustedFingerprint": "old" },
            "broken": { "args": [] }
        }))
        .unwrap();

        let counts = merge_import(&mut target, &source, false).unwrap();
        assert_eq!(counts.imported, vec!["fresh"]);
        assert_eq!(counts.skipped, vec!["local"]);
        assert_eq!(counts.conflicts, vec!["local"]);
        assert_eq!(counts.invalid, vec!["broken"]);

        // 配置里的其它顶层字段原样保留。
        assert_eq!(target["unrelated"]["keep"], true);
        // 本地同名条目未被覆盖。
        assert_eq!(target["mcpServers"]["local"]["command"], "python");
        // 新条目保留未知字段，但信任被清空。
        let fresh = &target["mcpServers"]["fresh"];
        assert_eq!(fresh["custom"], 42);
        assert_eq!(fresh["trusted"], false);
        assert!(fresh.get("trustedFingerprint").is_none());
    }

    #[test]
    fn import_can_replace_existing_entries_when_asked() {
        let mut target = serde_json::json!({
            "mcpServers": { "local": { "command": "python" } }
        });
        let source: BTreeMap<String, Value> = serde_json::from_value(serde_json::json!({
            "local": {
                "command": "node",
                "custom": { "nested": true },
                "trusted": true,
                "trustedFingerprint": "old"
            }
        }))
        .unwrap();

        let counts = merge_import(&mut target, &source, true).unwrap();
        assert_eq!(counts.imported, vec!["local"]);
        assert_eq!(counts.skipped, Vec::<String>::new());
        assert_eq!(counts.conflicts, vec!["local"]);
        let local = &target["mcpServers"]["local"];
        assert_eq!(local["command"], "node");
        assert_eq!(local["custom"]["nested"], true);
        assert_eq!(local["trusted"], false);
        assert!(local.get("trustedFingerprint").is_none());
    }

    #[test]
    fn fingerprint_covers_transport_and_environment() {
        let base = entry("x", "python");
        let base_fingerprint = base.fingerprint();

        let mut changed = base.clone();
        changed.args = vec!["server.py".to_string()];
        assert_ne!(changed.fingerprint(), base_fingerprint);

        let mut changed = base.clone();
        changed.env.insert("TOKEN".to_string(), "v".to_string());
        assert_ne!(changed.fingerprint(), base_fingerprint);

        let mut changed = base.clone();
        changed.url = Some("http://127.0.0.1:3000/mcp".to_string());
        assert_ne!(changed.fingerprint(), base_fingerprint);

        let mut changed = base.clone();
        changed
            .headers
            .insert("Authorization".to_string(), "Bearer t".to_string());
        assert_ne!(changed.fingerprint(), base_fingerprint);

        // 同样的配置每次得到同样的指纹（用于持久化后比对）。
        assert_eq!(entry("x", "python").fingerprint(), base_fingerprint);
    }
}
