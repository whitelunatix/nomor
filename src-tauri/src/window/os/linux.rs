pub(crate) fn window_decorations() -> bool {
    true
}

pub(crate) fn setup_window<R: tauri::Runtime>(
    _window: &tauri::WebviewWindow<R>,
) -> Result<(), String> {
    Ok(())
}

pub(crate) fn system_theme() -> &'static str {
    // TODO: 读取 GNOME `org.gnome.desktop.interface color-scheme` 等桌面环境设置，
    // 当前先固定为 light，与 macOS/Windows 版的动态读取保持接口一致。
    "light"
}

/// 将窗口置于前台。
///
/// Linux 桌面（X11/Wayland）下，仅靠 `set_focus()` 在窗口被最小化或隐藏时
/// 无法可靠还原并激活窗口。这里先 `show()` + `unminimize()` 确保窗口可见，
/// 再请求聚焦，行为更接近 Windows 版的 `SW_RESTORE` + `SetForegroundWindow`。
///
/// 注意：Wayland 协议不允许客户端主动抢焦点，部分 compositor（Mutter/KWin）
/// 下 `set_focus()` 可能只触发任务栏提示而非真正置顶，这是协议层面的限制，
/// 无法在客户端完全规避。
pub(crate) fn bring_window_to_front<R: tauri::Runtime>(window: &tauri::WebviewWindow<R>) {
    let _ = window.show();
    let _ = window.unminimize();
    let _ = window.set_focus();
}
