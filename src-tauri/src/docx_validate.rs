//! `.docx.md` 校验侧车进程。
//!
//! 桌面端不再维护一份 TypeScript 校验器的平行实现：`bin/docxmd_validate.exe`
//! 由 `mcp_server` 的 Python 校验器打包而来，前端只负责把 Markdown 文本交给
//! 它。进程常驻、按行收发 JSON，避免每次按键都付一次解释器启动成本；所有
//! 等待都在阻塞线程里完成，不占用 async 运行时。

use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::mpsc::{self, Receiver};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde_json::{json, Value};
use tauri::{AppHandle, Manager, State};

const EXE_NAME: &str = if cfg!(windows) {
    "docxmd_validate.exe"
} else {
    "docxmd_validate"
};

/// 首次请求要等 onefile 解包，之后只等一次纯 Python 校验。
const COLD_TIMEOUT: Duration = Duration::from_secs(25);
const WARM_TIMEOUT: Duration = Duration::from_secs(8);

struct ValidatorProcess {
    child: Child,
    stdin: ChildStdin,
    lines: Receiver<String>,
}

impl Drop for ValidatorProcess {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

#[derive(Default)]
struct ProcessSlot {
    process: Option<ValidatorProcess>,
}

/// 管理侧车进程的 Tauri 状态；所有请求串行化。
#[derive(Default)]
pub struct DocxValidator {
    slot: Arc<Mutex<ProcessSlot>>,
    request_seq: AtomicU64,
    warmed: AtomicBool,
}

fn validator_candidates(app: &AppHandle) -> Vec<PathBuf> {
    let mut candidates = Vec::new();
    if let Some(path) = std::env::var_os("NOMO_DOCX_VALIDATOR") {
        candidates.push(PathBuf::from(path));
    }
    if let Ok(resource_dir) = app.path().resource_dir() {
        candidates.push(resource_dir.join("bin").join(EXE_NAME));
    }
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            candidates.push(dir.join("bin").join(EXE_NAME));
        }
    }
    // 开发模式：资源目录指向 target/debug，源码树里的 bin/ 才是最新构建产物。
    #[cfg(debug_assertions)]
    {
        candidates.push(
            PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                .join("..")
                .join("bin")
                .join(EXE_NAME),
        );
    }
    candidates
}

fn resolve_validator(app: &AppHandle) -> Result<PathBuf, String> {
    validator_candidates(app)
        .into_iter()
        .find(|path| path.is_file())
        .ok_or_else(|| {
            format!(
                "docx validator sidecar not found; expected bin/{EXE_NAME} in the app resources"
            )
        })
}

fn spawn_process(exe: &Path) -> Result<ValidatorProcess, String> {
    let mut command = Command::new(exe);
    command
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        // 控制台程序在没有控制台窗口的情况下运行，避免每次校验闪黑框。
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(CREATE_NO_WINDOW);
    }
    let mut child = command
        .spawn()
        .map_err(|error| format!("cannot start {}: {error}", exe.display()))?;
    let stdin = child
        .stdin
        .take()
        .ok_or_else(|| "validator stdin unavailable".to_string())?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "validator stdout unavailable".to_string())?;
    let (sender, lines) = mpsc::channel::<String>();
    std::thread::Builder::new()
        .name("docx-validator-stdout".into())
        .spawn(move || {
            for line in BufReader::new(stdout).lines() {
                let Ok(line) = line else { break };
                if sender.send(line).is_err() {
                    break;
                }
            }
        })
        .map_err(|error| format!("cannot start validator reader: {error}"))?;
    Ok(ValidatorProcess {
        child,
        stdin,
        lines,
    })
}

impl DocxValidator {
    fn validate_blocking(
        slot: &Arc<Mutex<ProcessSlot>>,
        exe: &Path,
        payload: Value,
        timeout: Duration,
    ) -> Result<Value, String> {
        let mut slot = slot
            .lock()
            .map_err(|_| "docx validator state poisoned".to_string())?;
        let mut process = match slot.process.take() {
            Some(process) => process,
            None => spawn_process(exe)?,
        };

        let request_id = payload
            .get("id")
            .cloned()
            .unwrap_or_else(|| Value::String("0".into()));
        let mut line = serde_json::to_vec(&payload)
            .map_err(|error| format!("cannot encode validator request: {error}"))?;
        line.push(b'\n');

        let write = process
            .stdin
            .write_all(&line)
            .and_then(|_| process.stdin.flush());
        if let Err(error) = write {
            // 进程可能已经退出；丢弃后下一次请求会重新拉起。
            return Err(format!("validator stdin closed: {error}"));
        }

        let deadline = Instant::now() + timeout;
        loop {
            let remaining = deadline.saturating_duration_since(Instant::now());
            if remaining.is_zero() {
                return Err(format!(
                    "docx validator did not answer within {}s",
                    timeout.as_secs()
                ));
            }
            match process.lines.recv_timeout(remaining) {
                Ok(line) => {
                    let trimmed = line.trim();
                    if trimmed.is_empty() {
                        continue;
                    }
                    let Ok(response) = serde_json::from_str::<Value>(trimmed) else {
                        continue;
                    };
                    if response.get("id") != Some(&request_id) {
                        continue;
                    }
                    slot.process = Some(process);
                    return Ok(response);
                }
                Err(mpsc::RecvTimeoutError::Timeout) => {
                    return Err(format!(
                        "docx validator did not answer within {}s",
                        timeout.as_secs()
                    ));
                }
                Err(mpsc::RecvTimeoutError::Disconnected) => {
                    return Err("docx validator exited unexpectedly".to_string());
                }
            }
        }
    }
}

/// 校验一段 `.docx.md` 文本；`source_path` 仅用于解析相对导入与图片路径。
#[tauri::command]
pub async fn docx_validate_markdown(
    app: AppHandle,
    state: State<'_, DocxValidator>,
    markdown: String,
    source_path: Option<String>,
) -> Result<Value, String> {
    let exe = resolve_validator(&app)?;
    let seq = state.request_seq.fetch_add(1, Ordering::Relaxed);
    let timeout = if state.warmed.load(Ordering::Relaxed) {
        WARM_TIMEOUT
    } else {
        COLD_TIMEOUT
    };
    let payload = json!({
        "id": format!("docxmd-{seq}"),
        "markdown": markdown,
        "sourcePath": source_path,
    });
    let slot = state.slot.clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        DocxValidator::validate_blocking(&slot, &exe, payload, timeout)
    })
    .await
    .map_err(|error| format!("docx validator task failed: {error}"))?;

    if result.is_ok() {
        state.warmed.store(true, Ordering::Relaxed);
    }
    result
}
