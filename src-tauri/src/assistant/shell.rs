//! `shell_exec`：执行一条 shell 命令。
//!
//! 安全边界都在这一层：命令由用户在原生对话框里确认后才执行；工作目录与命令原文
//! 会显示在对话框中；子进程挂在 Job Object（Windows）或进程组（Unix）上，
//! 超时、取消或应用退出时连同子进程树一起结束。
//!
//! 输出是边读边截断的：命令可能无限输出，不能等 `wait_with_output` 全量缓冲。

use process_wrap::tokio::{CommandWrap, KillOnDrop};
#[cfg(unix)]
use process_wrap::tokio::ProcessGroup;
#[cfg(windows)]
use process_wrap::tokio::{CreationFlags, JobObject};
use serde::Serialize;
use serde_json::json;
use std::{
    collections::HashMap,
    fs,
    path::{Path, PathBuf},
    time::Duration,
};
use tauri::{AppHandle, State};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};
use tokio::{
    io::AsyncReadExt,
    sync::{oneshot, Mutex},
    task::JoinHandle,
};

use super::audit;
use super::files::path_within;
use super::limits::{SHELL_MAX_OUTPUT_BYTES as MAX_OUTPUT_BYTES};

const DEFAULT_TIMEOUT_MS: u64 = super::limits::SHELL_DEFAULT_TIMEOUT.as_millis() as u64;
const MIN_TIMEOUT_MS: u64 = super::limits::SHELL_MIN_TIMEOUT.as_millis() as u64;
const MAX_TIMEOUT_MS: u64 = super::limits::SHELL_MAX_TIMEOUT.as_millis() as u64;
/// 多读几个字节，解码后再按字符边界截断，避免正好切断一个多字节字符。
const OUTPUT_READ_LIMIT: usize = MAX_OUTPUT_BYTES + 8;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ShellOutput {
    pub(crate) exit_code: Option<i32>,
    pub(crate) stdout: String,
    pub(crate) stderr: String,
    pub(crate) truncated: bool,
}

/// 正在运行的命令，供「停止对话」时取消。
#[derive(Default)]
pub(crate) struct ShellRegistry {
    running: Mutex<HashMap<String, oneshot::Sender<()>>>,
}

impl ShellRegistry {
    async fn register(&self, call_id: &str) -> oneshot::Receiver<()> {
        let (sender, receiver) = oneshot::channel();
        self.running
            .lock()
            .await
            .insert(call_id.to_string(), sender);
        receiver
    }

    async fn finish(&self, call_id: &str) {
        self.running.lock().await.remove(call_id);
    }

    async fn cancel(&self, call_id: &str) -> bool {
        self.running
            .lock()
            .await
            .remove(call_id)
            .is_some_and(|sender| sender.send(()).is_ok())
    }
}

fn clamp_output(mut text: String) -> (String, bool) {
    if text.len() <= MAX_OUTPUT_BYTES {
        return (text, false);
    }
    let mut end = MAX_OUTPUT_BYTES;
    while !text.is_char_boundary(end) {
        end -= 1;
    }
    text.truncate(end);
    text.push_str("\n…（输出已截断）");
    (text, true)
}

/// Windows 控制台程序多输出 UTF-8；老程序可能是 GBK，统一退回 GB18030 解码。
fn decode(bytes: &[u8]) -> String {
    match std::str::from_utf8(bytes) {
        Ok(text) => text.to_string(),
        // 只有尾部不完整（读取上限截断可能在字符中间）：按有效前缀解码，
        // 不能因为最后几个字节就让整段中文退回 GB18030。
        Err(error) if error.error_len().is_none() => {
            String::from_utf8_lossy(&bytes[..error.valid_up_to()]).into_owned()
        }
        Err(_) => {
            let (cow, _, _) = encoding_rs::GB18030.decode(bytes);
            cow.into_owned()
        }
    }
}

fn finish_output(bytes: &[u8], truncated: bool) -> (String, bool) {
    let (mut text, clamped) = clamp_output(decode(bytes));
    let truncated = truncated || clamped;
    if truncated && !text.ends_with("…（输出已截断）") {
        text.push_str("\n…（输出已截断）");
    }
    (text, truncated)
}

/// 边读边丢：只保留前 `OUTPUT_READ_LIMIT` 字节，其余继续读掉以免子进程被管道阻塞。
async fn read_bounded<R>(pipe: Option<R>) -> (Vec<u8>, bool)
where
    R: tokio::io::AsyncRead + Unpin + Send + 'static,
{
    let Some(mut pipe) = pipe else {
        return (Vec::new(), false);
    };
    let mut buffer = Vec::with_capacity(8192);
    let mut chunk = [0u8; 8192];
    let mut truncated = false;
    loop {
        match pipe.read(&mut chunk).await {
            Ok(0) => break,
            Ok(read) => {
                if buffer.len() < OUTPUT_READ_LIMIT {
                    let remain = OUTPUT_READ_LIMIT - buffer.len();
                    buffer.extend_from_slice(&chunk[..read.min(remain)]);
                    if read > remain {
                        truncated = true;
                    }
                } else {
                    truncated = true;
                }
            }
            Err(_) => break,
        }
    }
    (buffer, truncated)
}

/// 读取任务结束后可能还有残留管道（例如孙进程握着句柄），最多再等两秒。
async fn collect_output(mut task: JoinHandle<(Vec<u8>, bool)>) -> (Vec<u8>, bool) {
    match tokio::time::timeout(Duration::from_secs(2), &mut task).await {
        Ok(Ok(value)) => value,
        _ => {
            task.abort();
            (Vec::new(), false)
        }
    }
}

/// 工作区根由前端按当前文档路径传入，Rust 只接受真实存在的目录。
/// 没有工作区（未保存文档、非文档标签页）时直接禁用 shell：
/// 一个没有边界的 shell 等于把整台机器交给模型。
fn resolve_workspace_root(workspace_root: Option<&str>) -> Result<PathBuf, String> {
    let raw = workspace_root
        .map(str::trim)
        .filter(|path| !path.is_empty())
        .ok_or_else(|| "当前标签页没有关联工作区，shell 工具不可用".to_string())?;
    let root = fs::canonicalize(raw).map_err(|error| format!("定位工作区失败：{error}"))?;
    if !root.is_dir() {
        return Err(format!("工作区不是目录：{}", root.display()));
    }
    Ok(root)
}

/// 允许的初始工作目录：省略时就是工作区根；相对路径按根解析。
/// 这只是「初始目录白名单」——命令内部仍然可以自己 cd，不能当成沙箱。
fn resolve_cwd(root: &Path, cwd: Option<&str>) -> Result<PathBuf, String> {
    let Some(raw) = cwd.map(str::trim).filter(|path| !path.is_empty()) else {
        return Ok(root.to_path_buf());
    };
    let requested = PathBuf::from(raw);
    let candidate = if requested.is_absolute() {
        requested
    } else {
        root.join(requested)
    };
    let canonical =
        fs::canonicalize(&candidate).map_err(|error| format!("工作目录不存在：{error}"))?;
    if !canonical.is_dir() {
        return Err(format!("工作目录不是目录：{}", canonical.display()));
    }
    if !path_within(root, &canonical) {
        return Err(format!(
            "工作目录必须在当前文档所在目录（{}）内",
            root.display()
        ));
    }
    Ok(canonical)
}

async fn confirm(
    app: &AppHandle,
    command: &str,
    cwd: &Path,
    title: Option<String>,
    allow_label: Option<String>,
    deny_label: Option<String>,
) -> bool {
    let (tx, rx) = oneshot::channel();
    // 对话框里的命令原文由 Rust 自己拼接，避免前端传什么就显示什么。
    let message = format!("工作目录：{}\n\n命令：\n{}", cwd.display(), command);
    app.dialog()
        .message(message)
        .title(title.unwrap_or_else(|| "允许执行命令？".to_string()))
        .kind(MessageDialogKind::Warning)
        .buttons(MessageDialogButtons::OkCancelCustom(
            allow_label.unwrap_or_else(|| "允许".to_string()),
            deny_label.unwrap_or_else(|| "拒绝".to_string()),
        ))
        .show(move |confirmed| {
            let _ = tx.send(confirmed);
        });
    rx.await.unwrap_or(false)
}

fn audit_shell(
    app: &AppHandle,
    call_id: Option<&str>,
    command: &str,
    cwd: &Path,
    result: &str,
) {
    audit::record(
        app,
        "shell_exec",
        &[
            ("callId", json!(call_id.unwrap_or(""))),
            ("command", json!(command)),
            ("cwd", json!(cwd.display().to_string())),
            ("result", json!(result)),
        ],
    );
}

enum Outcome {
    Finished(std::io::Result<std::process::ExitStatus>),
    TimedOut,
    Cancelled,
}

/// 没有取消请求时永远挂起，这样 `select!` 里可以只写一个等待分支。
async fn wait_for_cancel(cancel: &mut Option<oneshot::Receiver<()>>) {
    match cancel {
        Some(receiver) => {
            let _ = receiver.await;
        }
        None => std::future::pending::<()>().await,
    }
}

async fn run(
    command: &str,
    cwd: &Path,
    timeout: Duration,
    mut cancel: Option<oneshot::Receiver<()>>,
) -> Result<ShellOutput, String> {
    #[cfg(windows)]
    let mut wrap = CommandWrap::with_new("cmd", |cmd| {
        cmd.arg("/C").arg(command);
        cmd.current_dir(cwd);
    });
    #[cfg(not(windows))]
    let mut wrap = CommandWrap::with_new("sh", |cmd| {
        cmd.arg("-c").arg(command);
        cmd.current_dir(cwd);
    });

    // 超时或取消时杀死整棵进程树；Windows 再套一层 Job Object，
    // 保证 Nomor 退出时不会留下后台子进程。
    wrap.wrap(KillOnDrop);
    #[cfg(windows)]
    {
        use windows::Win32::System::Threading::PROCESS_CREATION_FLAGS;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        wrap.wrap(CreationFlags(PROCESS_CREATION_FLAGS(CREATE_NO_WINDOW)));
        wrap.wrap(JobObject);
    }
    // Unix 上 KillOnDrop 只会杀直接子进程；进程组让 `sh -c` 派生出的子树一起结束。
    #[cfg(unix)]
    wrap.wrap(ProcessGroup::leader());

    let mut child = wrap
        .spawn()
        .map_err(|error| format!("启动命令失败：{error}"))?;

    let stdout_task = tokio::spawn(read_bounded(child.stdout().take()));
    let stderr_task = tokio::spawn(read_bounded(child.stderr().take()));

    let deadline = tokio::time::sleep(timeout);
    tokio::pin!(deadline);
    let outcome = tokio::select! {
        result = child.wait() => Outcome::Finished(result),
        _ = &mut deadline => Outcome::TimedOut,
        _ = wait_for_cancel(&mut cancel) => Outcome::Cancelled,
    };

    if !matches!(&outcome, Outcome::Finished(Ok(_))) {
        // 先杀进程树再取输出，`kill()` 会等子进程退出。
        // process-wrap 返回的 future 不是 Unpin，先装进 Pin 才能 await。
        let killing = std::pin::Pin::from(child.kill());
        let _ = killing.await;
    }

    let (stdout_bytes, stdout_truncated) = collect_output(stdout_task).await;
    let (stderr_bytes, stderr_truncated) = collect_output(stderr_task).await;
    let (stdout, out_truncated) = finish_output(&stdout_bytes, stdout_truncated);
    let (stderr, err_truncated) = finish_output(&stderr_bytes, stderr_truncated);

    match outcome {
        Outcome::Finished(Ok(status)) => Ok(ShellOutput {
            exit_code: status.code(),
            stdout,
            stderr,
            truncated: out_truncated || err_truncated,
        }),
        Outcome::Finished(Err(error)) => Err(format!("执行命令失败：{error}")),
        Outcome::TimedOut => Err(format!("命令执行超时（{} 秒）", timeout.as_secs())),
        Outcome::Cancelled => Err("命令已取消".to_string()),
    }
}

#[tauri::command]
pub(crate) async fn assistant_shell_exec(
    app: AppHandle,
    registry: State<'_, ShellRegistry>,
    call_id: Option<String>,
    command: String,
    workspace_root: Option<String>,
    cwd: Option<String>,
    timeout_ms: Option<u64>,
    approval_title: Option<String>,
    allow_label: Option<String>,
    deny_label: Option<String>,
) -> Result<ShellOutput, String> {
    let command = command.trim().to_string();
    if command.is_empty() {
        return Err("命令不能为空".to_string());
    }
    let root = resolve_workspace_root(workspace_root.as_deref())?;
    let cwd = resolve_cwd(&root, cwd.as_deref())?;

    if !confirm(&app, &command, &cwd, approval_title, allow_label, deny_label).await {
        audit_shell(&app, call_id.as_deref(), &command, &cwd, "denied");
        return Err("用户拒绝了这次命令执行".to_string());
    }

    let timeout = Duration::from_millis(
        timeout_ms
            .unwrap_or(DEFAULT_TIMEOUT_MS)
            .clamp(MIN_TIMEOUT_MS, MAX_TIMEOUT_MS),
    );

    let cancel = match call_id.as_deref().filter(|id| !id.is_empty()) {
        Some(id) => Some(registry.register(id).await),
        None => None,
    };
    let result = run(&command, &cwd, timeout, cancel).await;
    if let Some(id) = call_id.as_deref().filter(|id| !id.is_empty()) {
        registry.finish(id).await;
    }

    match &result {
        Ok(output) => audit_shell(
            &app,
            call_id.as_deref(),
            &command,
            &cwd,
            &format!("exit={}", output.exit_code.unwrap_or(-1)),
        ),
        Err(error) => audit_shell(
            &app,
            call_id.as_deref(),
            &command,
            &cwd,
            &format!("error={error}"),
        ),
    }
    result
}

/// 用户点「停止」时由前端调用：只结束对应的那条命令，不影响其它并发调用。
#[tauri::command]
pub(crate) async fn assistant_shell_cancel(
    registry: State<'_, ShellRegistry>,
    call_id: String,
) -> Result<bool, String> {
    Ok(registry.cancel(&call_id).await)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn clamps_output_on_char_boundary() {
        let text = "中".repeat(MAX_OUTPUT_BYTES);
        let (clamped, truncated) = clamp_output(text);
        assert!(truncated);
        assert!(clamped.len() <= MAX_OUTPUT_BYTES + 32);
        assert!(clamped.contains("输出已截断"));
    }

    #[test]
    fn decodes_utf8_and_falls_back_to_gb18030() {
        assert_eq!(decode("中文".as_bytes()), "中文");
        let (gbk, _, _) = encoding_rs::GB18030.encode("中文");
        assert_eq!(decode(&gbk), "中文");
    }

    #[test]
    fn keeps_utf8_prefix_when_the_tail_was_cut_mid_character() {
        let mut bytes = "前缀中文".as_bytes().to_vec();
        bytes.pop(); // 砍掉最后一个字符的末尾字节
        assert_eq!(decode(&bytes), "前缀中");
    }

    #[test]
    fn marks_partial_output_as_truncated() {
        let (text, truncated) = finish_output(b"short", true);
        assert!(truncated);
        assert!(text.contains("输出已截断"));
    }

    fn temp_dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "nomo-shell-{tag}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|value| value.as_nanos())
                .unwrap_or(0)
        ));
        std::fs::create_dir_all(&dir).expect("create temp dir");
        dir
    }

    #[test]
    fn requires_a_workspace_root() {
        assert!(resolve_workspace_root(None).is_err());
        assert!(resolve_workspace_root(Some("   ")).is_err());
        assert!(resolve_workspace_root(Some("/definitely/missing/nomo")).is_err());
    }

    #[test]
    fn defaults_cwd_to_the_workspace_root() {
        let root = temp_dir("default-cwd");
        let canonical_root = std::fs::canonicalize(&root).expect("canonical");
        let resolved = resolve_cwd(&canonical_root, None).expect("default cwd");
        assert_eq!(resolved, canonical_root);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn accepts_relative_and_absolute_directories_inside_the_root() {
        let root = temp_dir("inside");
        let child = root.join("notes");
        std::fs::create_dir_all(&child).expect("create child");
        let canonical_root = std::fs::canonicalize(&root).expect("canonical root");
        let canonical_child = std::fs::canonicalize(&child).expect("canonical child");

        assert_eq!(
            resolve_cwd(&canonical_root, Some("notes")).expect("relative"),
            canonical_child
        );
        assert_eq!(
            resolve_cwd(&canonical_root, Some(&canonical_child.to_string_lossy()))
                .expect("absolute"),
            canonical_child
        );
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn rejects_directories_outside_the_workspace() {
        let root = temp_dir("root");
        let outside = temp_dir("outside");
        let canonical_root = std::fs::canonicalize(&root).expect("canonical root");
        let canonical_outside = std::fs::canonicalize(&outside).expect("canonical outside");

        let error = resolve_cwd(&canonical_root, Some(&canonical_outside.to_string_lossy()))
            .expect_err("outside cwd must be rejected");
        assert!(error.contains("当前文档所在目录"), "{error}");
        assert!(resolve_cwd(&canonical_root, Some("../")).is_err());
        let _ = std::fs::remove_dir_all(&root);
        let _ = std::fs::remove_dir_all(&outside);
    }
}
