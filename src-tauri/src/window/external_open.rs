use crate::models::SettingInput;
use serde::Serialize;
use std::{
    collections::HashSet,
    env,
    path::{Path, PathBuf},
    sync::{Mutex, OnceLock},
};
#[cfg(any(target_os = "macos", test))]
use tauri::Url;
use tauri::{AppHandle, Emitter, Manager, WebviewWindow};

const OPEN_DOCUMENT_EVENT: &str = "nomo://open-document";
const OPEN_FOLDER_EVENT: &str = "nomo://open-folder";
const PENDING_EXTERNAL_OPEN_PREFIX: &str = "pendingExternalOpen:";
const PENDING_EXTERNAL_FOLDER_PREFIX: &str = "pendingFolder:";

static EARLY_EXTERNAL_OPEN_PATHS: OnceLock<Mutex<Vec<String>>> = OnceLock::new();

#[derive(Clone, Debug, Serialize)]
struct ExternalOpenPayload {
    #[serde(rename = "windowLabel")]
    window_label: String,
    paths: Vec<String>,
}

#[derive(Clone, Debug, Serialize)]
struct ExternalFolderOpenPayload {
    #[serde(rename = "windowLabel")]
    window_label: String,
    folder_path: String,
}

#[derive(Debug, Default)]
pub(crate) struct ExternalOpenTargets {
    pub(crate) markdown_paths: Vec<String>,
    pub(crate) folder_paths: Vec<String>,
}

#[allow(dead_code)]
pub(crate) fn collect_markdown_paths_from_startup_args() -> Vec<String> {
    collect_external_open_targets_from_startup_args().markdown_paths
}

#[allow(dead_code)]
pub(crate) fn collect_markdown_paths_from_args(
    args: Vec<String>,
    cwd: Option<PathBuf>,
) -> Vec<String> {
    collect_external_open_targets_from_args(args, cwd).markdown_paths
}

pub(crate) fn collect_external_open_targets_from_startup_args() -> ExternalOpenTargets {
    let args = env::args().collect::<Vec<_>>();
    let cwd = env::current_dir().ok();
    collect_external_open_targets_from_args(args, cwd)
}

pub(crate) fn collect_external_open_targets_from_args(
    args: Vec<String>,
    cwd: Option<PathBuf>,
) -> ExternalOpenTargets {
    let exe_path = env::current_exe().ok();
    let mut seen = HashSet::new();
    let mut targets = ExternalOpenTargets::default();

    for arg in args {
        if arg.starts_with('-') {
            continue;
        }

        let candidate = PathBuf::from(&arg);
        let absolute = if candidate.is_absolute() {
            candidate
        } else if let Some(cwd) = cwd.as_ref() {
            cwd.join(candidate)
        } else {
            candidate
        };

        if is_supported_external_file(&absolute, exe_path.as_deref()) {
            let normalized = normalize_path(&absolute);
            if seen.insert(normalized.clone()) {
                targets.markdown_paths.push(normalized);
            }
        } else if is_supported_external_folder(&absolute, exe_path.as_deref()) {
            let normalized = normalize_path(&absolute);
            if seen.insert(normalized.clone()) {
                targets.folder_paths.push(normalized);
            }
        }
    }

    targets
}

#[cfg(any(target_os = "macos", test))]
pub(crate) fn collect_markdown_paths_from_urls(urls: Vec<Url>) -> Vec<String> {
    let exe_path = env::current_exe().ok();
    let mut seen = HashSet::new();
    let mut paths = Vec::new();

    for url in urls {
        if url.scheme() != "file" {
            continue;
        }
        let Ok(path) = url.to_file_path() else {
            continue;
        };
        if is_supported_external_file(&path, exe_path.as_deref()) {
            let normalized = normalize_path(&path);
            if seen.insert(normalized.clone()) {
                paths.push(normalized);
            }
        }
    }

    paths
}

pub(crate) fn queue_early_external_open(paths: Vec<String>) -> Result<(), String> {
    let mut pending = EARLY_EXTERNAL_OPEN_PATHS
        .get_or_init(|| Mutex::new(Vec::new()))
        .lock()
        .map_err(|_| "锁定 setup 前外部打开队列失败".to_string())?;
    for path in paths {
        if !pending.contains(&path) {
            pending.push(path);
        }
    }
    Ok(())
}

pub(crate) fn take_early_external_open_paths() -> Result<Vec<String>, String> {
    let mut pending = EARLY_EXTERNAL_OPEN_PATHS
        .get_or_init(|| Mutex::new(Vec::new()))
        .lock()
        .map_err(|_| "锁定 setup 前外部打开队列失败".to_string())?;
    Ok(std::mem::take(&mut *pending))
}

pub(crate) fn route_external_open(app: &AppHandle, paths: Vec<String>) -> Result<(), String> {
    if super::workspace_lifecycle::is_exiting() {
        let app = app.clone();
        tauri::async_runtime::spawn(async move {
            super::workspace_lifecycle::wait_until_idle().await;
            if let Err(error) = route_external_open(&app, paths) {
                crate::app_logger::error("ExternalOpen", &error);
            }
        });
        return Ok(());
    }
    if paths.is_empty() {
        return Ok(());
    }

    let Some(window) = target_document_window(app) else {
        persist_pending_external_open(app, "main", &paths)?;
        return Ok(());
    };

    let label = window.label().to_string();
    let _ = persist_pending_external_open(app, &label, &paths);

    // 这里只转交请求；前端确定使用当前窗口或需要询问时再激活，避免新窗口模式唤起旧窗口。
    window
        .emit(
            OPEN_DOCUMENT_EVENT,
            ExternalOpenPayload {
                window_label: label.clone(),
                paths: paths.clone(),
            },
        )
        .map_err(|error| format!("发送外部打开文件事件失败：{error}"))?;
    Ok(())
}

// 传统 Explorer 菜单会逐文件启动进程；先合并短时间内的请求，再按整批选择窗口。
// 仅在有请求时创建任务；静默 150ms 后发送，连续请求最多等待 1s。
#[derive(Default)]
struct ExternalOpenBatch {
    paths: Vec<String>,
    started: Option<std::time::Instant>,
    last_received: Option<std::time::Instant>,
}
impl ExternalOpenBatch {
    fn push(&mut self, paths: Vec<String>, now: std::time::Instant) -> bool {
        let start = self.started.is_none();
        self.started.get_or_insert(now);
        self.last_received = Some(now);
        for path in paths {
            if !self.paths.contains(&path) { self.paths.push(path); }
        }
        start
    }

    fn take_ready(&mut self, now: std::time::Instant) -> Option<Vec<String>> {
        let quiet = self.last_received.is_some_and(|time| now.duration_since(time).as_millis() >= 150);
        let expired = self.started.is_some_and(|time| now.duration_since(time).as_millis() >= 1000);
        if !quiet && !expired { return None; }
        self.started = None;
        self.last_received = None;
        Some(std::mem::take(&mut self.paths))
    }
}
static EXTERNAL_OPEN_BATCH: OnceLock<Mutex<ExternalOpenBatch>> = OnceLock::new();

pub(crate) fn queue_external_open_targets(app: &AppHandle, targets: ExternalOpenTargets) -> Result<(), String> {
    if !targets.folder_paths.is_empty() {
        return route_external_open_targets(app, targets);
    }
    if targets.markdown_paths.is_empty() { return Ok(()); }
    let should_start = {
        let mut batch = EXTERNAL_OPEN_BATCH.get_or_init(Default::default).lock()
            .map_err(|_| "锁定外部打开批次失败".to_string())?;
        batch.push(targets.markdown_paths, std::time::Instant::now())
    };
    if should_start {
        let app = app.clone();
        tauri::async_runtime::spawn(async move {
            loop {
                tokio::time::sleep(std::time::Duration::from_millis(150)).await;
                let paths = {
                    let Ok(mut batch) = EXTERNAL_OPEN_BATCH.get().unwrap().lock() else {
                        crate::app_logger::error("ExternalOpen", "读取外部打开批次失败");
                        return;
                    };
                    let Some(paths) = batch.take_ready(std::time::Instant::now()) else { continue; };
                    paths
                };
                crate::app_logger::info("ExternalOpen", &format!("合并外部打开批次：files={}", paths.len()));
                if let Err(error) = route_external_open(&app, paths) {
                    crate::app_logger::error("ExternalOpen", &error);
                }
                break;
            }
        });
    }
    Ok(())
}

pub(crate) fn route_external_open_targets(
    app: &AppHandle,
    targets: ExternalOpenTargets,
) -> Result<(), String> {
    route_external_open(app, targets.markdown_paths)?;
    if let Some(folder_path) = targets.folder_paths.into_iter().next() {
        route_external_folder_open(app, folder_path)?;
    }
    Ok(())
}

pub(crate) fn route_external_folder_open(
    app: &AppHandle,
    folder_path: String,
) -> Result<(), String> {
    if super::workspace_lifecycle::is_exiting() {
        let app = app.clone();
        tauri::async_runtime::spawn(async move {
            super::workspace_lifecycle::wait_until_idle().await;
            if let Err(error) = route_external_folder_open(&app, folder_path) {
                crate::app_logger::error("ExternalOpen", &error);
            }
        });
        return Ok(());
    }

    if folder_path.is_empty() {
        return Ok(());
    }

    let Some(window) = target_document_window(app) else {
        persist_pending_external_folder_open(app, "main", &folder_path)?;
        return Ok(());
    };

    let label = window.label().to_string();
    let _ = persist_pending_external_folder_open(app, &label, &folder_path);

    // 恢复窗口显示并强制到前台（处理托盘/最小化/后台等各种状态）
    window
        .show()
        .map_err(|error| format!("显示外部打开目标窗口失败：{error}"))?;
    window
        .unminimize()
        .map_err(|error| format!("还原外部打开目标窗口失败：{error}"))?;
    window
        .set_focus()
        .map_err(|error| format!("聚焦外部打开目标窗口失败：{error}"))?;
    crate::window::os::bring_window_to_front(&window);

    // 延迟补一次激活，确保在 WebView 初始化或异步场景下也能成功
    let window_for_focus = window.clone();
    tauri::async_runtime::spawn(async move {
        std::thread::sleep(std::time::Duration::from_millis(120));
        let _ = window_for_focus.show();
        let _ = window_for_focus.unminimize();
        let _ = window_for_focus.set_focus();
        crate::window::os::bring_window_to_front(&window_for_focus);
    });

    window
        .emit(
            OPEN_FOLDER_EVENT,
            ExternalFolderOpenPayload {
                window_label: label.clone(),
                folder_path: folder_path.clone(),
            },
        )
        .map_err(|error| format!("发送外部打开文件夹事件失败：{error}"))?;
    crate::window::tray::set_tray_active(app, true);
    Ok(())
}

pub(crate) fn persist_pending_external_open(
    app: &AppHandle,
    label: &str,
    paths: &[String],
) -> Result<(), String> {
    if paths.is_empty() {
        return Ok(());
    }

    let key = pending_external_open_key(label);
    crate::config::with_manager(app, |manager| {
        manager.update(|config| {
            update_pending_paths(config, &key, paths, false);
        })
    })
}

// 读改写由 ConfigManager 的同一个写锁保护，Explorer 连续逐文件启动不能互相覆盖。
fn update_pending_paths(
    config: &mut crate::config::AppConfig,
    key: &str,
    paths: &[String],
    consume: bool,
) -> Vec<String> {
    let mut pending: Vec<String> = config.app.settings.get(key)
        .and_then(|record| serde_json::from_str(&record.value_json).ok())
        .unwrap_or_default();
    let mut taken = Vec::new();
    if consume {
        pending.retain(|path| {
            if paths.is_empty() || paths.contains(path) {
                taken.push(path.clone());
                false
            } else { true }
        });
    } else {
        for path in paths {
            if !pending.contains(path) { pending.push(path.clone()); }
        }
    }
    config.app.settings.insert(key.to_string(), crate::models::SettingRecord {
        key: key.to_string(),
        // Vec<String> 序列化不会失败。
        value_json: serde_json::to_string(&pending).expect("serialize pending paths"),
        updated_at: crate::config::now_ts(),
    });
    taken
}

/// 不传路径时原子取走启动队列；传路径时只确认该事件，不能清掉随后到达的文件。
#[tauri::command]
pub(crate) fn take_pending_external_open(
    app: AppHandle,
    window: WebviewWindow,
    paths: Option<Vec<String>>,
) -> Result<Vec<String>, String> {
    let key = pending_external_open_key(window.label());
    let mut taken = Vec::new();
    crate::config::with_manager(&app, |manager| {
        manager.update(|config| {
            taken = update_pending_paths(config, &key, &paths.unwrap_or_default(), true);
        })
    })?;
    Ok(taken)
}

pub(crate) fn persist_pending_external_folder_open(
    app: &AppHandle,
    label: &str,
    folder_path: &str,
) -> Result<(), String> {
    if folder_path.is_empty() {
        return Ok(());
    }

    let key = pending_external_folder_key(label);
    crate::config::commands::update_app_setting(
        app.clone(),
        SettingInput {
            key,
            value_json: serde_json::to_string(folder_path)
                .map_err(|error| format!("序列化待外部打开文件夹失败：{error}"))?,
        },
    )
}

pub(crate) fn pending_external_open_key(label: &str) -> String {
    format!("{PENDING_EXTERNAL_OPEN_PREFIX}{label}")
}

pub(crate) fn pending_external_folder_key(label: &str) -> String {
    format!("{PENDING_EXTERNAL_FOLDER_PREFIX}{label}")
}

pub(crate) fn is_document_window_label(label: &str) -> bool {
    label == "main" || (label.starts_with("window-") && label != "window-settings")
}

fn target_document_window(app: &AppHandle) -> Option<WebviewWindow> {
    for (label, window) in app.webview_windows() {
        if is_document_window_label(&label) && window.is_focused().unwrap_or(false) {
            return Some(window);
        }
    }

    app.get_webview_window("main")
}

fn is_supported_external_file(path: &Path, exe_path: Option<&Path>) -> bool {
    if let Some(exe_path) = exe_path {
        if same_path(path, exe_path) {
            return false;
        }
    }

    if !has_supported_extension(path) || !path.is_file() {
        return false;
    }

    true
}

fn is_supported_external_folder(path: &Path, exe_path: Option<&Path>) -> bool {
    if let Some(exe_path) = exe_path {
        if same_path(path, exe_path) {
            return false;
        }
    }

    path.is_dir()
}

pub(super) fn has_supported_extension(path: &Path) -> bool {
    path.extension()
        .and_then(|extension| extension.to_str())
        .map(|extension| {
            let extension = extension.to_ascii_lowercase();
            matches!(extension.as_str(), "md" | "markdown" | "txt" | "json")
        })
        .unwrap_or(false)
}

fn same_path(left: &Path, right: &Path) -> bool {
    let left = left.canonicalize().unwrap_or_else(|_| left.to_path_buf());
    let right = right.canonicalize().unwrap_or_else(|_| right.to_path_buf());
    left == right
}

fn normalize_path(path: &Path) -> String {
    let canonical = path.canonicalize().unwrap_or_else(|_| path.to_path_buf());

    let path_str = canonical.to_string_lossy();
    // Windows 上 canonicalize() 会产生 \\?\ 前缀的扩展长度路径，需要去除以友好显示
    if path_str.starts_with(r"\\?\") {
        let without_prefix = &path_str[4..];
        if without_prefix.starts_with(r"UNC\") {
            // 网络路径: \\?\UNC\server\share → \\server\share
            format!(r"\\{}", &without_prefix[4..])
        } else {
            without_prefix.to_string()
        }
    } else {
        path_str.to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[test]
    fn queues_setup_time_external_open_paths_without_duplicates() {
        queue_early_external_open(vec![
            "/tmp/first.md".to_string(),
            "/tmp/first.md".to_string(),
        ])
        .unwrap();
        queue_early_external_open(vec!["/tmp/second.md".to_string()]).unwrap();

        assert_eq!(
            take_early_external_open_paths().unwrap(),
            vec!["/tmp/first.md".to_string(), "/tmp/second.md".to_string()]
        );
        assert!(take_early_external_open_paths().unwrap().is_empty());
    }

    #[test]
    fn external_burst_batches_until_quiet_with_a_bounded_delay() {
        use std::time::{Duration, Instant};
        let mut batch = super::ExternalOpenBatch::default();
        let now = Instant::now();
        assert!(batch.push(vec!["a.md".into()], now));
        assert!(!batch.push(vec!["a.md".into(), "b.md".into()], now + Duration::from_millis(100)));
        assert!(batch.take_ready(now + Duration::from_millis(150)).is_none());
        assert_eq!(batch.take_ready(now + Duration::from_millis(250)), Some(vec!["a.md".into(), "b.md".into()]));
        assert!(batch.push(vec!["c.md".into()], now + Duration::from_millis(300)));
        for offset in (400..=1300).step_by(100) {
            batch.push(vec![format!("{offset}.md")], now + Duration::from_millis(offset));
        }
        assert_eq!(batch.take_ready(now + Duration::from_millis(1300)).unwrap().len(), 11);
        assert!(batch.paths.is_empty());
    }

    #[test]
    fn pending_requests_accumulate_and_acknowledgements_preserve_later_files() {
        let mut config = crate::config::AppConfig::default();
        let key = "pendingExternalOpen:main";
        let first = vec!["a.md".to_string()];
        let second = vec!["b.md".to_string(), "c.txt".to_string()];
        super::update_pending_paths(&mut config, key, &first, false);
        super::update_pending_paths(&mut config, key, &second, false);
        super::update_pending_paths(&mut config, key, &first, false);
        assert_eq!(super::update_pending_paths(&mut config, key, &first, true), first);
        assert_eq!(super::update_pending_paths(&mut config, key, &[], true), second);
        assert!(super::update_pending_paths(&mut config, key, &[], true).is_empty());
    }

    #[test]
    fn collects_existing_markdown_paths_from_args() {
        let dir = env::temp_dir().join(format!("nomo-external-open-{}", crate::config::now_ts()));
        fs::create_dir_all(&dir).unwrap();
        let md = dir.join("测试 文件.md");
        let ignored = dir.join("ignored.exe");
        fs::write(&md, "# ok").unwrap();
        fs::write(&ignored, "no").unwrap();

        let paths = collect_markdown_paths_from_args(
            vec![
                "Nomo.exe".to_string(),
                md.to_string_lossy().to_string(),
                ignored.to_string_lossy().to_string(),
            ],
            None,
        );

        assert_eq!(paths, vec![normalize_path(&md)]);
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn accepts_shell_extension_activation_marker_before_paths() {
        let dir =
            env::temp_dir().join(format!("nomo-shell-activation-{}", crate::config::now_ts()));
        fs::create_dir_all(&dir).unwrap();
        let md = dir.join("shell file.md");
        fs::write(&md, "# shell").unwrap();

        let targets = collect_external_open_targets_from_args(
            vec![
                "Nomo.exe".to_string(),
                "--nomo-shell-open".to_string(),
                md.to_string_lossy().to_string(),
            ],
            None,
        );

        assert_eq!(targets.markdown_paths, vec![normalize_path(&md)]);
        assert!(targets.folder_paths.is_empty());
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn collects_json_paths_from_args() {
        let dir = env::temp_dir().join(format!(
            "nomo-external-open-json-{}",
            crate::config::now_ts()
        ));
        fs::create_dir_all(&dir).unwrap();
        let json = dir.join("large-data.json");
        fs::write(&json, "{}").unwrap();

        let paths = collect_markdown_paths_from_args(
            vec!["Nomo.exe".to_string(), json.to_string_lossy().to_string()],
            None,
        );

        assert_eq!(paths, vec![normalize_path(&json)]);
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn collects_txt_paths_from_args() {
        let dir = env::temp_dir().join(format!(
            "nomo-external-open-txt-{}",
            crate::config::now_ts()
        ));
        fs::create_dir_all(&dir).unwrap();
        let txt = dir.join("large-data.txt");
        fs::write(&txt, "plain text").unwrap();

        let paths = collect_markdown_paths_from_args(
            vec!["Nomo.exe".to_string(), txt.to_string_lossy().to_string()],
            None,
        );

        assert_eq!(paths, vec![normalize_path(&txt)]);
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn resolves_relative_args_with_cwd() {
        let dir = env::temp_dir().join(format!(
            "nomo-external-open-relative-{}",
            crate::config::now_ts()
        ));
        fs::create_dir_all(&dir).unwrap();
        let md = dir.join("demo.markdown");
        fs::write(&md, "# ok").unwrap();

        let paths = collect_markdown_paths_from_args(
            vec!["Nomo.exe".to_string(), "demo.markdown".to_string()],
            Some(dir.clone()),
        );

        assert_eq!(paths, vec![normalize_path(&md)]);
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn collects_existing_folder_paths_from_args() {
        let dir = env::temp_dir().join(format!(
            "nomo-external-open-folder-{}",
            crate::config::now_ts()
        ));
        fs::create_dir_all(&dir).unwrap();
        let md = dir.join("demo.md");
        fs::write(&md, "# ok").unwrap();

        let targets = collect_external_open_targets_from_args(
            vec![
                "Nomo.exe".to_string(),
                dir.to_string_lossy().to_string(),
                md.to_string_lossy().to_string(),
            ],
            None,
        );

        assert_eq!(targets.folder_paths, vec![normalize_path(&dir)]);
        assert_eq!(targets.markdown_paths, vec![normalize_path(&md)]);
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn collects_file_urls() {
        let dir = env::temp_dir().join(format!(
            "nomo-external-open-url-{}",
            crate::config::now_ts()
        ));
        fs::create_dir_all(&dir).unwrap();
        let md = dir.join("demo.md");
        fs::write(&md, "# ok").unwrap();
        let url = Url::from_file_path(&md).unwrap();

        let paths = collect_markdown_paths_from_urls(vec![url]);

        assert_eq!(paths, vec![normalize_path(&md)]);
        let _ = fs::remove_dir_all(dir);
    }
}
