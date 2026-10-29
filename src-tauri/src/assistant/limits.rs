//! 助手后端的统一资源上限。
//!
//! 这些数值决定「一次调用最多能占多少内存/磁盘、最多等多久」。散落在各模块里
//! 容易出现同一个限制在两处不一致，或者新加的调用漏掉超时；集中放在这里，
//! 修改时也能一眼看到全部边界。

use std::time::Duration;

// ---- 网络（流式网关与连通性探测） ----
pub(crate) const CONNECT_TIMEOUT: Duration = Duration::from_secs(20);
pub(crate) const PROBE_TIMEOUT: Duration = Duration::from_secs(30);
pub(crate) const MAX_PROBE_BODY_CHARS: usize = 16_384;
/// 探测只读这么多字节就够展示错误信息，不能为了 16KB 文本先读完整响应体。
pub(crate) const MAX_PROBE_BYTES: usize = 64 * 1024;
/// 长时间没有新分片（推理模型思考阶段）就视为卡死。
pub(crate) const STREAM_IDLE_TIMEOUT: Duration = Duration::from_secs(120);
/// 单次响应最多接收 32MB，防止异常服务端把内存吃满。
pub(crate) const MAX_STREAM_BYTES: usize = 32 * 1024 * 1024;

// ---- MCP ----
pub(crate) const MCP_CONNECT_TIMEOUT: Duration = Duration::from_secs(45);
pub(crate) const MCP_CALL_TIMEOUT: Duration = Duration::from_secs(300);
pub(crate) const MCP_LIST_TOOLS_TIMEOUT: Duration = Duration::from_secs(15);
pub(crate) const MCP_HEALTH_TIMEOUT: Duration = Duration::from_secs(10);
/// 连接失败后这段时间内不再自动重试；显式健康检查可以绕过。
pub(crate) const MCP_FAILURE_COOLDOWN: Duration = Duration::from_secs(30);
pub(crate) const MCP_MAX_TOOL_PAGES: usize = 20;
/// 工具结果跨 IPC 前先截断，避免一条巨型返回把 webview 卡死。
pub(crate) const MCP_MAX_RESULT_BYTES: usize = 128 * 1024;
pub(crate) const MCP_MAX_CALL_ID_LENGTH: usize = 64;
/// 取消墓碑只保留最近这么多个，防止长期运行无限增长。
pub(crate) const MCP_MAX_CANCELLED_CALLS: usize = 64;

// ---- shell ----
pub(crate) const SHELL_DEFAULT_TIMEOUT: Duration = Duration::from_secs(120);
pub(crate) const SHELL_MIN_TIMEOUT: Duration = Duration::from_secs(5);
pub(crate) const SHELL_MAX_TIMEOUT: Duration = Duration::from_secs(600);
pub(crate) const SHELL_MAX_OUTPUT_BYTES: usize = 128 * 1024;

// ---- 文件工具 ----
pub(crate) const FILE_MAX_READ_BYTES: u64 = 1024 * 1024;
pub(crate) const FILE_MAX_WRITE_BYTES: usize = 2 * 1024 * 1024;
pub(crate) const FILE_MAX_LIST_ENTRIES: usize = 500;
pub(crate) const FILE_MAX_LIST_DEPTH: usize = 3;
pub(crate) const FILE_BINARY_PROBE_BYTES: usize = 8 * 1024;

// ---- skills ----
pub(crate) const SKILL_MAX_CONTENT_BYTES: usize = 60 * 1024;
pub(crate) const SKILL_MAX_FILE_BYTES: u64 = 2 * 1024 * 1024;
pub(crate) const SKILL_MAX_RESOURCE_BYTES: u64 = 256 * 1024;
pub(crate) const SKILL_MAX_RESOURCE_FILES: usize = 200;
pub(crate) const SKILL_MAX_RESOURCE_DEPTH: usize = 3;
pub(crate) const SKILL_MAX_RESOURCE_PATH_LENGTH: usize = 512;

// ---- 会话 ----
pub(crate) const SESSION_MAX_BYTES: u64 = 10 * 1024 * 1024;
pub(crate) const SESSION_MAX_COUNT: usize = 500;

// ---- 审计 ----
/// 单个审计文件超过这个大小就轮转。
pub(crate) const AUDIT_MAX_BYTES: u64 = 5 * 1024 * 1024;
/// 轮转后保留的文件总数（当前文件 + 4 个历史文件）。
pub(crate) const AUDIT_MAX_FILES: usize = 5;
/// 单字段截断：命令原文、错误栈都可能很长，不能整段落盘。
pub(crate) const AUDIT_FIELD_MAX_BYTES: usize = 4 * 1024;
