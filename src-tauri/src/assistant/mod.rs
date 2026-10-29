//! AI 助手后端。
//!
//! Agent 循环、文档工具与界面都在前端；这里只放 webview 不该直接持有的特权能力：
//! API Key（系统凭据管理器）、流式网络请求（密钥只在 Rust 注入）、会话落盘。
//! 后续的 MCP 子进程与 shell 也归入本模块。

pub(crate) mod audit;
pub(crate) mod files;
pub(crate) mod limits;
pub(crate) mod mcp;
pub(crate) mod prefs;
pub(crate) mod redact;
pub(crate) mod secrets;
pub(crate) mod sessions;
pub(crate) mod shell;
pub(crate) mod skills;
pub(crate) mod stream;
pub(crate) mod url_guard;
