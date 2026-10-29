use webview2_com::AcceleratorKeyPressedEventHandler;
use webview2_com::Microsoft::Web::WebView2::Win32::{
    ICoreWebView2AcceleratorKeyPressedEventArgs2, ICoreWebView2Controller, ICoreWebView2Settings3,
};
use windows_core::Interface;
use windows_sys::Win32::Foundation::RECT;
use windows_sys::Win32::System::Registry::{RegGetValueW, HKEY_CURRENT_USER, RRF_RT_REG_DWORD};
use windows_sys::Win32::UI::WindowsAndMessaging::{
    GetClientRect, GetWindowRect, IsZoomed, SetForegroundWindow, SetWindowPos, ShowWindow,
    HWND_NOTOPMOST, HWND_TOPMOST, SWP_NOACTIVATE, SWP_NOMOVE, SWP_NOSIZE, SWP_NOZORDER, SW_RESTORE,
    SW_SHOW,
};

pub(crate) fn window_decorations() -> bool {
    false
}

pub(crate) fn setup_window<R: tauri::Runtime>(
    window: &tauri::WebviewWindow<R>,
) -> Result<(), String> {
    // 由 Tauri/Tao 统一处理无装饰窗口的阴影、缩放边框和最大化工作区。
    // 前端只绘制标题栏内容和窗口控制按钮，不再叠加项目自有的 DWM frame。
    if window
        .is_decorated()
        .map_err(|error| format!("读取 Windows 窗口边框状态失败：{error}"))?
    {
        window
            .set_decorations(window_decorations())
            .map_err(|error| format!("启用 Windows 无边框窗口失败：{error}"))?;
        window
            .set_shadow(true)
            .map_err(|error| format!("启用 Windows 无边框窗口阴影失败：{error}"))?;
    }

    Ok(())
}

/// 在每个应用 WebView 创建后安装一次，覆盖主窗口、新窗口和独立设置窗口。
pub(crate) fn browser_shortcut_plugin<R: tauri::Runtime>() -> tauri::plugin::TauriPlugin<R> {
    tauri::plugin::Builder::new("browser-shortcuts")
        .on_webview_ready(|webview| {
            let label = webview.label().to_string();
            if !crate::window::external_open::is_document_window_label(&label)
                && label != crate::window::commands::SETTINGS_WINDOW_LABEL
            {
                return;
            }

            let native_label = label.clone();
            if let Err(error) =
                webview.with_webview(move |native| {
                    match disable_browser_shortcuts(&native.controller(), &native_label) {
                        Ok(()) => crate::app_logger::info(
                            "BrowserShortcuts",
                            &format!("已禁用浏览器默认快捷键：label={native_label}"),
                        ),
                        Err(error) => report_browser_shortcut_error(&native_label, &error),
                    }
                })
            {
                report_browser_shortcut_error(&label, &error);
            }
        })
        .build()
}

fn disable_browser_shortcuts(
    controller: &ICoreWebView2Controller,
    label: &str,
) -> windows_core::Result<()> {
    let label = label.to_string();
    unsafe {
        let settings = controller.CoreWebView2()?.Settings()?;
        settings
            .cast::<ICoreWebView2Settings3>()?
            .SetAreBrowserAcceleratorKeysEnabled(false)?;

        // Tauri 在创建 WebView 时已发起首次导航，全局设置可能到下次导航才生效。
        // 逐次关闭浏览器处理立即生效；不设置 Handled，让 Nomo 和编辑器继续收到按键。
        let handler = AcceleratorKeyPressedEventHandler::create(Box::new(move |_, args| {
            let Some(args) = args else {
                return Ok(());
            };
            let result = args
                .cast::<ICoreWebView2AcceleratorKeyPressedEventArgs2>()
                .and_then(|args| args.SetIsBrowserAcceleratorKeyEnabled(false));
            if let Err(error) = &result {
                report_browser_shortcut_error(&label, error);
            }
            result
        }));
        // Controller 持有监听器并随 WebView 一起释放；闭包不反向持有 Controller 或窗口。
        let mut token = 0;
        controller.add_AcceleratorKeyPressed(&handler, &mut token)?;
    }
    Ok(())
}

fn report_browser_shortcut_error(label: &str, error: &dyn std::fmt::Display) {
    let message = format!("禁用浏览器默认快捷键失败：label={label} error={error}");
    crate::app_logger::error("BrowserShortcuts", &message);
    if !crate::app_logger::is_enabled() {
        eprintln!("{message}");
    }
}

/// 在已还原的窗口上一次更新位置和客户区尺寸，保持可见性、焦点与 Z 序。
pub(crate) fn set_window_geometry(
    window: &tauri::WebviewWindow,
    position: tauri::PhysicalPosition<i32>,
    size: tauri::PhysicalSize<u32>,
) -> Result<(), String> {
    let hwnd = window
        .hwnd()
        .map_err(|error| format!("读取 Windows 窗口句柄失败：{error}"))?
        .0;
    let mut outer = RECT::default();
    let mut inner = RECT::default();
    unsafe {
        if GetWindowRect(hwnd, &mut outer) == 0 || GetClientRect(hwnd, &mut inner) == 0 {
            return Err(format!(
                "读取 Windows 窗口边界失败：{}",
                std::io::Error::last_os_error()
            ));
        }
    }

    // 无边框窗口的系统阴影仍有隐藏边距，沿用 Tao 的客户区/外框差值算法。
    let width_offset = (outer.right - outer.left - (inner.right - inner.left)).max(0);
    let height_offset = (outer.bottom - outer.top - (inner.bottom - inner.top)).max(0);
    let width = i32::try_from(size.width)
        .map_err(|_| "窗口宽度超出 Windows 支持范围".to_string())?
        .saturating_add(width_offset);
    let height = i32::try_from(size.height)
        .map_err(|_| "窗口高度超出 Windows 支持范围".to_string())?
        .saturating_add(height_offset);
    let updated = unsafe {
        SetWindowPos(
            hwnd,
            std::ptr::null_mut(),
            position.x,
            position.y,
            width,
            height,
            SWP_NOZORDER | SWP_NOACTIVATE,
        )
    };
    if updated == 0 {
        return Err(format!(
            "更新 Windows 窗口边界失败：{}",
            std::io::Error::last_os_error()
        ));
    }
    Ok(())
}

pub(crate) fn system_theme() -> &'static str {
    if read_apps_use_light_theme() == Some(0) {
        "dark"
    } else {
        "light"
    }
}

fn read_apps_use_light_theme() -> Option<u32> {
    const PERSONALIZE_SUBKEY: &str =
        "Software\\Microsoft\\Windows\\CurrentVersion\\Themes\\Personalize";
    const APPS_USE_LIGHT_THEME_VALUE: &str = "AppsUseLightTheme";

    let subkey = wide_null(PERSONALIZE_SUBKEY);
    let value_name = wide_null(APPS_USE_LIGHT_THEME_VALUE);
    let mut value_type = 0u32;
    let mut value = 1u32;
    let mut value_size = std::mem::size_of::<u32>() as u32;

    let status = unsafe {
        RegGetValueW(
            HKEY_CURRENT_USER,
            subkey.as_ptr(),
            value_name.as_ptr(),
            RRF_RT_REG_DWORD,
            &mut value_type,
            (&mut value as *mut u32).cast(),
            &mut value_size,
        )
    };

    if status == 0 {
        Some(value)
    } else {
        None
    }
}

fn wide_null(value: &str) -> Vec<u16> {
    value.encode_utf16().chain(std::iter::once(0)).collect()
}

/// 使用 Win32 API 强制窗口到前台。
///
/// Windows 有前台窗口激活限制：非前台进程不能随意将自己的窗口设为前台。
/// 当通过单实例插件接收外部打开请求时，Nomo 进程可能不是当前前台进程，
/// 仅靠 Tauri 的 `set_focus()` 无法可靠激活窗口。
/// 本函数通过临时置顶（TOPMOST）技巧配合 `SetForegroundWindow` 来绕过限制。
pub(crate) fn bring_window_to_front<R: tauri::Runtime>(window: &tauri::WebviewWindow<R>) {
    let Ok(hwnd) = window.hwnd() else {
        return;
    };
    let hwnd = hwnd.0;
    unsafe {
        // 如果窗口已最大化，使用 SW_SHOW 保持最大化状态；
        // 否则使用 SW_RESTORE 从最小化/隐藏状态还原窗口。
        let show_cmd = if IsZoomed(hwnd) != 0 {
            SW_SHOW
        } else {
            SW_RESTORE
        };
        ShowWindow(hwnd, show_cmd);
        SetWindowPos(hwnd, HWND_TOPMOST, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE);
        SetWindowPos(hwnd, HWND_NOTOPMOST, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE);
        SetForegroundWindow(hwnd);
    }
}
