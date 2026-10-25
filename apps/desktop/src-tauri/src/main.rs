#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use tauri::{
    Emitter,
    menu::{Menu, MenuItem},
    tray::TrayIconBuilder,
    webview::PageLoadEvent,
    LogicalPosition, LogicalSize, Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder,
    WindowEvent,
};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};

#[cfg(windows)]
use windows_sys::Win32::UI::Input::KeyboardAndMouse::{GetAsyncKeyState, VK_LBUTTON, VK_RBUTTON};

/// 鼠标左键当前是否按下。用系统级查询，避免依赖 WebView 的指针事件。
#[cfg(windows)]
fn left_button_down() -> bool {
    // 高位为 1 表示当前按下；这里只关心当前状态，不关心"自上次查询后按过"
    unsafe { (GetAsyncKeyState(VK_LBUTTON as i32) as u16 & 0x8000) != 0 }
}

/// 鼠标右键当前是否按下。角色菜单不依赖 WebView 的 contextmenu 事件。
#[cfg(windows)]
fn right_button_down() -> bool {
    unsafe { (GetAsyncKeyState(VK_RBUTTON as i32) as u16 & 0x8000) != 0 }
}

#[cfg(not(windows))]
fn left_button_down() -> bool {
    false
}

#[cfg(not(windows))]
fn right_button_down() -> bool {
    false
}

/// 走动线程的诊断日志。后台线程出错时不会弹窗，只能落盘排查。
fn walker_log(message: &str) {
    use std::io::Write;
    let path = std::env::current_exe()
        .ok()
        .and_then(|path| path.parent().map(|parent| parent.join("companion-walker.log")))
        .unwrap_or_else(|| std::env::temp_dir().join("companion-walker.log"));
    if let Ok(mut file) = std::fs::OpenOptions::new().create(true).append(true).open(path) {
        let _ = writeln!(file, "{message}");
    }
}

/// 角色窗口的运行状态。
struct PetState {
    /// 是否允许向已选目标移动。默认待机，不再自主随机走动。
    walking: AtomicBool,
    /// 已选中角色，正在等待用户点击桌面设置下一个终点。
    destination_pending: AtomicBool,
    /// 角色菜单是否打开。
    menu_open: AtomicBool,
    /// 角色窗口内所有可见浮层的命中矩形 (x, y, width, height)，单位为 CSS 像素。
    /// 菜单和小聊天面板都通过这里上报，透明空白区域仍然可以穿透鼠标。
    overlay_bounds: Mutex<Vec<[f64; 4]>>,
    /// 角色轮廓的命中区域：窗口内逻辑坐标的圆 (x, y, r)。
    /// 用来判断鼠标是否落在角色身上，决定窗口是否穿透。
    hit_regions: Mutex<Vec<[f64; 3]>>,
}

impl Default for PetState {
    fn default() -> Self {
        Self {
            // 角色启动后原地待机，只有用户明确选择目的地时才移动。
            walking: AtomicBool::new(false),
            destination_pending: AtomicBool::new(false),
            menu_open: AtomicBool::new(false),
            overlay_bounds: Mutex::new(Vec::new()),
            hit_regions: Mutex::new(Vec::new()),
        }
    }
}

/// 广播给角色窗口的步态信息。
#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct GaitPayload {
    walking: bool,
    direction: i32,
    depth: f64,
    speed: f64,
}

/// 角色窗口的默认逻辑尺寸，与 tauri.conf.json 保持一致。
const PET_DEFAULT_WIDTH: f64 = 380.0;
const PET_DEFAULT_HEIGHT: f64 = 620.0;

/// 独立聊天窗口的默认逻辑尺寸。
const CHAT_DEFAULT_WIDTH: f64 = 340.0;
const CHAT_DEFAULT_HEIGHT: f64 = 420.0;
const CHAT_MIN_WIDTH: f64 = 300.0;
const CHAT_MIN_HEIGHT: f64 = 320.0;

/// 角色窗口允许的最小逻辑尺寸。
/// 走动时角色会走到"远处"并把窗口缩到默认尺寸的 52%（约 198×322），
/// 所以下限必须低于这个值，否则窗口会被系统钳住，出现角色卡住不动的现象。
const PET_MIN_WIDTH: f64 = 150.0;
const PET_MIN_HEIGHT: f64 = 240.0;

/// 窗口状态文件在 DPI 缩放不同的显示器之间切换时可能写入不合理的尺寸，
/// 这里做一次兜底校验：尺寸过小或超出当前显示器工作区时回退到默认值。
fn normalize_pet_window(window: &WebviewWindow) {
    let scale = window.scale_factor().unwrap_or(1.0);
    let Ok(size) = window.outer_size() else {
        return;
    };
    let logical_width = size.width as f64 / scale;
    let logical_height = size.height as f64 / scale;

    let size_invalid = logical_width < PET_MIN_WIDTH
        || logical_height < PET_MIN_HEIGHT
        || logical_width > PET_DEFAULT_WIDTH * 1.5
        || logical_height > PET_DEFAULT_HEIGHT * 1.5;

    let Ok(Some(monitor)) = window.current_monitor() else {
        if size_invalid {
            let _ = window.set_size(LogicalSize::new(PET_DEFAULT_WIDTH, PET_DEFAULT_HEIGHT));
        }
        let _ = window.set_position(LogicalPosition::new(80.0, 80.0));
        return;
    };

    let work = monitor.work_area();
    let monitor_scale = monitor.scale_factor();
    let min_x = work.position.x as f64;
    let min_y = work.position.y as f64;
    let max_x = min_x + work.size.width as f64;
    let max_y = min_y + work.size.height as f64;

    // 旧版本会把桌宠的位置写进 window-state。恢复后窗口可能完全在屏幕外，
    // 用户便只能看到主窗口。桌宠位置始终由走动线程管理，这里只保证启动时
    // 它至少有一部分落在当前显示器工作区内。
    let position_invalid = window
        .outer_position()
        .map(|position| {
            let x = position.x as f64;
            let y = position.y as f64;
            x + size.width as f64 <= min_x + 24.0
                || y + size.height as f64 <= min_y + 24.0
                || x >= max_x - 24.0
                || y >= max_y - 24.0
        })
        .unwrap_or(true);

    if size_invalid {
        let _ = window.set_size(LogicalSize::new(PET_DEFAULT_WIDTH, PET_DEFAULT_HEIGHT));
    }

    if position_invalid || size_invalid {
        let physical_width = PET_DEFAULT_WIDTH * monitor_scale;
        let physical_height = PET_DEFAULT_HEIGHT * monitor_scale;
        let x = min_x + (work.size.width as f64 - physical_width).max(0.0) * 0.5;
        let y = (max_y - physical_height - 32.0 * monitor_scale).max(min_y);
        let _ = window.set_position(tauri::PhysicalPosition::new(x.round() as i32, y.round() as i32));
    }

    let _ = window.show();
    let _ = window.set_always_on_top(true);
}

fn create_pet_window(app: &tauri::AppHandle) -> tauri::Result<WebviewWindow> {
    walker_log("pet window build start");
    let built = WebviewWindowBuilder::new(
        app,
        "pet",
        WebviewUrl::App("index.html?window=pet&pet=1&transparent=1".into()),
    )
    .title("角色")
    .inner_size(PET_DEFAULT_WIDTH, PET_DEFAULT_HEIGHT)
    .min_inner_size(PET_MIN_WIDTH, PET_MIN_HEIGHT)
    .resizable(true)
    .decorations(false)
    .transparent(true)
    .always_on_top(true)
    .skip_taskbar(true)
    .shadow(false)
    .visible(true)
    .initialization_script(
        "window.addEventListener('contextmenu', (event) => event.preventDefault(), { capture: true });",
    )
    .build();
    let window = match built {
        Ok(window) => window,
        Err(error) => {
            walker_log(&format!("pet window build failed: {error}"));
            return Err(error);
        }
    };
    walker_log("pet window build finished");
    normalize_pet_window(&window);
    match window.show() {
        Ok(()) => {
            let size = window
                .outer_size()
                .map(|size| format!("{}x{}", size.width, size.height))
                .unwrap_or_else(|error| format!("size-error:{error}"));
            let position = window
                .outer_position()
                .map(|position| format!("{},{}", position.x, position.y))
                .unwrap_or_else(|error| format!("position-error:{error}"));
            walker_log(&format!(
                "pet window shown: visible={:?} size={size} position={position}",
                window.is_visible()
            ));
        }
        Err(error) => walker_log(&format!("pet window show failed: {error}")),
    }
    Ok(window)
}

fn position_chat_window_near_pet(window: &WebviewWindow, app: &tauri::AppHandle) {
    let Ok(chat_size) = window.outer_size() else {
        return;
    };
    let pet = app.get_webview_window("pet");
    let pet_position = pet.as_ref().and_then(|item| item.outer_position().ok());
    let pet_size = pet.as_ref().and_then(|item| item.outer_size().ok());
    let monitor = pet
        .as_ref()
        .and_then(|item| item.current_monitor().ok().flatten())
        .or_else(|| window.current_monitor().ok().flatten());
    let Some(monitor) = monitor else {
        return;
    };

    let work = monitor.work_area();
    let scale = monitor.scale_factor();
    let min_x = work.position.x;
    let min_y = work.position.y;
    let max_x = (min_x + work.size.width as i32 - chat_size.width as i32).max(min_x);
    let max_y = (min_y + work.size.height as i32 - chat_size.height as i32).max(min_y);
    let gap = (12.0 * scale).round() as i32;

    let (x, y) = if let (Some(position), Some(size)) = (pet_position, pet_size) {
        let right = position.x + size.width as i32 + gap;
        let preferred_x = if right <= max_x {
            right
        } else {
            position.x - chat_size.width as i32 - gap
        };
        (preferred_x.clamp(min_x, max_x), (position.y + gap).clamp(min_y, max_y))
    } else {
        (
            (min_x + (work.size.width as i32 - chat_size.width as i32) / 2).clamp(min_x, max_x),
            (min_y + (work.size.height as i32 - chat_size.height as i32) / 2).clamp(min_y, max_y),
        )
    };

    let _ = window.set_position(tauri::PhysicalPosition::new(x, y));
}

fn chat_window_has_visible_area(window: &WebviewWindow, app: &tauri::AppHandle) -> bool {
    let (Ok(position), Ok(size)) = (window.outer_position(), window.outer_size()) else {
        return false;
    };
    let monitor = window
        .current_monitor()
        .ok()
        .flatten()
        .or_else(|| app.primary_monitor().ok().flatten());
    let Some(monitor) = monitor else {
        return false;
    };
    let work = monitor.work_area();
    let min_x = work.position.x;
    let min_y = work.position.y;
    let max_x = min_x + work.size.width as i32;
    let max_y = min_y + work.size.height as i32;
    let visible_width = (position.x + size.width as i32).min(max_x) - position.x.max(min_x);
    let visible_height = (position.y + size.height as i32).min(max_y) - position.y.max(min_y);
    visible_width >= 80 && visible_height >= 80
}

fn fit_chat_window_to_monitor(window: &WebviewWindow) {
    let Ok(Some(monitor)) = window.current_monitor() else {
        return;
    };
    let work = monitor.work_area();
    let scale = monitor.scale_factor();
    let target_width = (CHAT_DEFAULT_WIDTH * scale).round() as u32;
    let target_height = (CHAT_DEFAULT_HEIGHT * scale).round() as u32;
    let width = target_width.min(work.size.width);
    let height = target_height.min(work.size.height);
    if let Ok(size) = window.outer_size() {
        if size.width != width || size.height != height {
            let _ = window.set_size(tauri::PhysicalSize::new(width, height));
        }
    }
}

fn create_chat_window(app: &tauri::AppHandle) -> tauri::Result<WebviewWindow> {
    walker_log("chat window build start");
    let built = WebviewWindowBuilder::new(
        app,
        "chat",
        WebviewUrl::App("index.html?window=chat&transparent=1".into()),
    )
    .title("聊天")
    .inner_size(CHAT_DEFAULT_WIDTH, CHAT_DEFAULT_HEIGHT)
    .min_inner_size(CHAT_MIN_WIDTH, CHAT_MIN_HEIGHT)
    .resizable(true)
    .decorations(false)
    .transparent(true)
    .always_on_top(false)
    .skip_taskbar(true)
    .shadow(false)
    // 透明 WebView2 窗口如果在构建阶段就显示，Windows 偶尔会先绘制空白表面。
    // 先隐藏，等调用 open_pet_chat 时再显示，避免留下透明空壳窗口。
    .visible(false)
    .on_page_load(|window, payload| {
        if payload.event() == PageLoadEvent::Finished {
            let url = payload.url().to_string();
            let probe = window
                .eval(
                    "JSON.stringify({url:location.href,title:document.title,root:!!document.getElementById('root'),body:document.body?.innerText?.slice(0,80)||''})",
                )
                .err()
                .map(|error| error.to_string())
                .unwrap_or_default();
            walker_log(&format!(
                "chat page loaded: url={url} eval={probe} visible={:?}",
                window.is_visible()
            ));
        }
    })
    .build();
    let window = match built {
        Ok(window) => window,
        Err(error) => {
            walker_log(&format!("chat window build failed: {error}"));
            return Err(error);
        }
    };
    walker_log("chat window build finished");
    position_chat_window_near_pet(&window, app);
    // WebView2 在某些 Windows 版本上会忽略构建参数里的 visible(false)，
    // 因此在页面创建完成后显式隐藏，保证启动时不弹出聊天框。
    let _ = window.hide();
    let size = window
        .outer_size()
        .map(|value| format!("{}x{}", value.width, value.height))
        .unwrap_or_else(|error| format!("size-error:{error}"));
    let position = window
        .outer_position()
        .map(|value| format!("{},{}", value.x, value.y))
        .unwrap_or_else(|error| format!("position-error:{error}"));
    walker_log(&format!(
        "chat window created hidden: visible={:?} size={size} position={position}",
        window.is_visible()
    ));
    Ok(window)
}

#[tauri::command]
fn open_pet_chat(app: tauri::AppHandle) -> Result<(), String> {
    walker_log("open_pet_chat invoked");
    let window = if let Some(window) = app.get_webview_window("chat") {
        window
    } else {
        match create_chat_window(&app) {
            Ok(window) => window,
            Err(error) => {
                walker_log(&format!("chat window creation failed: {error}"));
                return Err(error.to_string());
            }
        }
    };
    if !chat_window_has_visible_area(&window, &app) {
        walker_log("chat window was off-screen; repositioning near pet");
        position_chat_window_near_pet(&window, &app);
    }
    if window.url().map(|url| !url.as_str().contains("window=chat")).unwrap_or(false) {
        let target = app
            .get_webview_window("main")
            .and_then(|main| main.url().ok())
            .and_then(|url| url.join("index.html?window=chat&transparent=1").ok());
        if let Some(target) = target {
            let _ = window.navigate(target);
        }
    }
    fit_chat_window_to_monitor(&window);
    window.show().map_err(|error| error.to_string())?;
    let _ = window.unminimize();
    window.set_focus().map_err(|error| error.to_string())?;
    walker_log(&format!(
        "chat window shown: visible={:?} position={:?} size={:?}",
        window.is_visible(),
        window.outer_position().ok(),
        window.outer_size().ok()
    ));
    Ok(())
}

#[tauri::command]
fn hide_pet_chat(app: tauri::AppHandle) -> Result<(), String> {
    if let Some(window) = app.get_webview_window("chat") {
        window.hide().map_err(|error| error.to_string())?;
    }
    Ok(())
}

#[tauri::command]
fn focus_pet(app: tauri::AppHandle) -> Result<(), String> {
    if let Some(window) = app.get_webview_window("pet") {
        window.show().map_err(|error| error.to_string())?;
        window.set_focus().map_err(|error| error.to_string())?;
    }
    Ok(())
}

/// 确保角色窗口存在。
///
/// WebView2 不能在任意后台线程里并发创建。主页面加载完成后通过 Tauri
/// command 调用这里，窗口会在应用主线程中创建，避免启动时出现
/// "请求的资源在使用中" 而只剩主窗口。
fn ensure_pet_window_impl(app: &tauri::AppHandle) -> Result<bool, String> {
    if let Some(window) = app.get_webview_window("pet") {
        normalize_pet_window(&window);
        let _ = window.show();
        return Ok(false);
    }

    match create_pet_window(app) {
        Ok(window) => {
            let _ = window.show();
            Ok(true)
        }
        Err(error) => {
            walker_log(&format!("pet window creation failed: {error}"));
            Err(error.to_string())
        }
    }
}

#[tauri::command]
fn ensure_pet_window(app: tauri::AppHandle) -> Result<bool, String> {
    ensure_pet_window_impl(&app)
}

/// 启动兜底：延迟一段时间后把创建动作投递回主线程。
///
/// 即使生产环境的 WebView 没有正确暴露全局 Tauri API，或者前端脚本被拦截，
/// 角色窗口仍然会由桌面壳自己创建。
fn schedule_pet_window(app: tauri::AppHandle) {
    std::thread::spawn(move || {
        // setup 阶段会优先同步创建角色窗口；这里只负责在它失败时兜底。
        // 不能在主页面里直接创建第二个 WebView2：当前 Tauri/WebView2
        // 组合会阻塞事件循环，窗口标题会停在"未响应"。
        std::thread::sleep(Duration::from_millis(4000));
        let main_app = app.clone();
        if let Err(error) = app.run_on_main_thread(move || {
            match ensure_pet_window_impl(&main_app) {
                Ok(created) => walker_log(if created {
                    "pet window created from startup fallback"
                } else {
                    "pet window already exists"
                }),
                Err(error) => walker_log(&format!("pet window startup fallback failed: {error}")),
            }
        }) {
            walker_log(&format!("could not schedule pet window on main thread: {error}"));
        }
    });
}

/// 开启/关闭鼠标穿透。穿透开启时角色窗口不拦截点击，方便桌面其他操作。
#[tauri::command]
fn set_click_through(window: WebviewWindow, enabled: bool) -> Result<(), String> {
    window
        .set_ignore_cursor_events(enabled)
        .map_err(|error| error.to_string())
}

/// 切换角色窗口置顶，返回切换后的状态。
#[tauri::command]
fn toggle_always_on_top(window: WebviewWindow) -> Result<bool, String> {
    let current = window.is_always_on_top().map_err(|error| error.to_string())?;
    window
        .set_always_on_top(!current)
        .map_err(|error| error.to_string())?;
    Ok(!current)
}

/// 显示并聚焦主窗口。
fn show_main_window_impl(app: &tauri::AppHandle) -> Result<(), String> {
    let window = app
        .get_webview_window("main")
        .ok_or_else(|| "主窗口已被销毁".to_string())?;
    window.show().map_err(|error| error.to_string())?;
    window.unminimize().map_err(|error| error.to_string())?;
    window.set_focus().map_err(|error| error.to_string())?;
    Ok(())
}

#[tauri::command]
fn show_main_window(app: tauri::AppHandle) -> Result<(), String> {
    show_main_window_impl(&app)
}

/// 查询角色是否正在走动，供角色窗口启动时同步状态。
#[tauri::command]
fn get_pet_walking(state: tauri::State<'_, PetState>) -> bool {
    state.walking.load(Ordering::Relaxed)
}

/// 切换角色走动状态，并把结果广播给角色窗口，让动画与窗口位移保持一致。
#[tauri::command]
fn set_pet_walking(app: tauri::AppHandle, state: tauri::State<'_, PetState>, enabled: bool) -> bool {
    state.walking.store(enabled, Ordering::Relaxed);
    let _ = app.emit_to("pet", "pet://walking", enabled);
    enabled
}

/// 打开/关闭角色菜单。
///
/// 菜单只负责停止当前行走和同步前端状态，不会改变“持续选择移动终点”模式。
#[tauri::command]
fn set_pet_menu_open(app: tauri::AppHandle, state: tauri::State<'_, PetState>, open: bool) -> bool {
    state.menu_open.store(open, Ordering::Relaxed);
    if open {
        state.walking.store(false, Ordering::Relaxed);
        let _ = app.emit_to("pet", "pet://walking", false);
    }
    let _ = app.emit_to("pet", "pet://menu-open", open);
    open
}

/// 同步菜单和聊天面板在角色窗口内的可交互区域。
#[tauri::command]
fn set_pet_overlay_bounds(state: tauri::State<'_, PetState>, bounds: Vec<[f64; 4]>) {
    if let Ok(mut stored) = state.overlay_bounds.lock() {
        *stored = bounds;
    }
}

/// 从托盘直接进入“选择移动位置”状态，不显示角色菜单。
#[tauri::command]
fn set_pet_destination_mode(
    app: tauri::AppHandle,
    state: tauri::State<'_, PetState>,
    enabled: bool,
) -> bool {
    state.destination_pending.store(enabled, Ordering::Relaxed);
    if enabled {
        state.menu_open.store(false, Ordering::Relaxed);
    }
    let _ = app.emit_to("pet", "pet://menu-open", false);
    let _ = app.emit_to("pet", "pet://destination-mode", enabled);
    enabled
}

#[tauri::command]
fn quit_app(app: tauri::AppHandle) {
    app.exit(0);
}

/// 角色轮廓命中区域（窗口内逻辑坐标的圆），由角色窗口定期上报。
/// 走动线程用它判断鼠标是否落在角色身上，从而决定窗口是否穿透。
#[tauri::command]
fn set_pet_hit_regions(state: tauri::State<'_, PetState>, regions: Vec<[f64; 3]>) {
    if let Ok(mut stored) = state.hit_regions.lock() {
        *stored = regions;
    }
}

/// 把桌面当成一块 3D 地面来走动。
///
/// 角色在地面上有一个位置 `(x, depth)`：`depth` 表示远近（0 最远、1 最近），
/// 它同时决定两件事——脚底所在的屏幕高度（透视）和窗口的显示尺寸（近大远小）。
/// 每帧把算出来的位置与尺寸写回窗口，屏幕上就呈现出"角色在桌面空间里走动"，
/// 而不是一张贴纸在平面上平移。
///
/// 命中测试也在这一线程里做：鼠标落在角色轮廓内才接收点击，否则窗口穿透，
/// 这样角色飘在别的窗口前面时不会挡住操作。
fn spawn_pet_walker(app: tauri::AppHandle) {
    /// 角色在"最近处"的逻辑尺寸，与 tauri.conf.json 保持一致。
    const BASE_WIDTH: f64 = 380.0;
    const BASE_HEIGHT: f64 = 620.0;
    /// 最远处 / 最近处的显示比例。
    /// 桌宠不宜占掉太多屏幕，最近处也留出余量，最远处明显变小以体现纵深。
    const SCALE_FAR: f64 = 0.36;
    const SCALE_NEAR: f64 = 0.92;
    /// 深度取值范围（0 最远、1 最近）。
    /// 范围收窄一点，角色不会走到屏幕最顶端，头部始终留在可见区域。
    const DEPTH_MIN: f64 = 0.3;
    const DEPTH_MAX: f64 = 1.0;
    /// 地平线与最近处脚底在显示器高度上的位置。
    const HORIZON_RATIO: f64 = 0.28;
    const NEAR_RATIO: f64 = 0.93;
    /// 相机取景留了 8% 余量，脚底大约落在窗口高度的 96% 处。
    const FOOT_RATIO: f64 = 0.963;
    /// 最近处的地面速度（逻辑像素/秒）。
    ///
    /// 前端步态周期为 1.1 秒；实测单脚一个周期前进约 0.593 世界单位，
    /// 模型投影为 275.3 逻辑像素/世界单位，因此地面速度约为
    /// 0.593 / 1.1 * 275.3 ≈ 148 逻辑像素/秒。速度必须和脚底跨距同步，
    /// 否则角色会出现明显滑步。
    const GROUND_SPEED: f64 = 148.0;

    std::thread::spawn(move || {
        let mut depth: f64 = 0.7;
        let mut x = f64::NAN; // 脚底中心的 x（物理像素），首帧按显示器居中
        let mut ground_y = f64::NAN; // 脚底中心的屏幕 y（物理像素）
        let mut target_x = f64::NAN;
        let mut target_ground_y = f64::NAN;
        let mut target_depth: f64 = 0.7;
        let mut direction: f64 = -1.0;
        let mut rest_until = Instant::now();
        let mut last = Instant::now();
        let mut expected_position: Option<(f64, f64)> = None;
        let mut announced_walking: Option<bool> = None;
        let mut announced_direction = 0_i32;
        let mut announced_at = Instant::now() - Duration::from_secs(1);
        // 鼠标离开轮廓后延迟一点再切成穿透，避免拖动时鼠标短暂滑出导致拖拽中断
        let mut interactive_until = Instant::now() - Duration::from_secs(1);
        let mut click_through: Option<bool> = None;
        // 拖动状态：按住角色本体时窗口直接跟随鼠标
        let mut dragging = false;
        let mut drag_start_cursor: Option<(f64, f64)> = None;
        let mut drag_start_window: Option<(f64, f64)> = None;
        let mut has_destination = false;
        let mut was_button_down = false;
        let mut was_right_button_down = false;
        let mut left_click_origin: Option<(f64, f64)> = None;
        let mut left_click_started_on_pet = false;
        let mut left_dragged = false;
        let mut right_click_started_on_pet = false;

        loop {
            std::thread::sleep(Duration::from_millis(16));
            let now = Instant::now();
            let delta = (now - last).as_secs_f64().min(0.05);
            last = now;

            // 单帧出错不能让角色永久卡住：捕获 panic、记日志，然后继续下一帧
            let tick = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                'tick: {
            let Some(window) = app.get_webview_window("pet") else { break 'tick };
            if !window.is_visible().unwrap_or(false) {
                break 'tick;
            }
            let Ok(Some(monitor)) = window.current_monitor() else { break 'tick };

            let dpi = monitor.scale_factor();
            let monitor_x = monitor.position().x as f64;
            let monitor_y = monitor.position().y as f64;
            let monitor_w = monitor.size().width as f64;
            let monitor_h = monitor.size().height as f64;
            let horizon_y = monitor_y + monitor_h * HORIZON_RATIO;
            let near_y = monitor_y + monitor_h * NEAR_RATIO;

            // 窗口尺寸在整个行走过程中保持不变，纵深改由角色页缩放三维模型来体现。
            // 透明窗口每帧 resize 会让 WebView2 重排并闪一帧，用户看到的就是
            // 角色"突然消失又出现"，所以这里彻底不再 set_size。
            // 尺寸仍每帧实测，这样用户手动调整过窗口大小时取景换算依然正确。
            let (win_w, win_h) = match window.outer_size() {
                Ok(size) => (
                    (size.width as f64 / dpi).max(PET_MIN_WIDTH),
                    (size.height as f64 / dpi).max(PET_MIN_HEIGHT),
                ),
                Err(_) => (BASE_WIDTH, BASE_HEIGHT),
            };

            // 首帧：站在显示器中间偏左
            if !x.is_finite() {
                x = monitor_x + monitor_w * 0.5;
                ground_y = horizon_y + (near_y - horizon_y) * depth;
                target_x = x;
                target_ground_y = ground_y;
                target_depth = depth;
                expected_position = None;
            }

            let walking = app
                .try_state::<PetState>()
                .map(|state| state.walking.load(Ordering::Relaxed))
                .unwrap_or(false);
            let destination_pending = app
                .try_state::<PetState>()
                .map(|state| state.destination_pending.load(Ordering::Relaxed))
                .unwrap_or(false);
            let overlay_bounds = app
                .try_state::<PetState>()
                .and_then(|state| state.overlay_bounds.lock().ok().map(|bounds| bounds.clone()))
                .unwrap_or_default();

            // 当前位置：窗口外部位置可能被系统或用户改动，统一以实际值为准
            let cursor = window.cursor_position().ok();
            let actual = window.outer_position().ok();

            // 命中测试先算：拖动判定和鼠标穿透都要用。
            // 坐标统一在窗口内 CSS 像素空间，再乘 dpi 换算成物理像素比较。
            let regions = {
                let reported = app
                    .try_state::<PetState>()
                    .and_then(|state| state.hit_regions.lock().ok().map(|r| r.clone()))
                    .unwrap_or_default();
                if reported.is_empty() {
                    // 模型还没加载完（或加载失败）时没有轮廓上报，用窗口内一条居中的
                    // 人物条带兜底，保证角色区域仍然可以点、可以拖，空白区域照常穿透
                    let scale = SCALE_FAR + (SCALE_NEAR - SCALE_FAR) * depth;
                    // 角色以脚底为锚点缩放在窗口里，脚底落在窗口高度的 FOOT_RATIO 处
                    let char_h = win_h * scale;
                    let foot_y = win_h * FOOT_RATIO;
                    let cx = win_w * 0.5;
                    vec![
                        [cx, foot_y - char_h * 0.82, char_h * 0.13],
                        [cx, foot_y - char_h * 0.55, char_h * 0.17],
                        [cx, foot_y - char_h * 0.30, char_h * 0.16],
                    ]
                } else {
                    reported
                }
            };
            let (inside, overlay_inside) = match (cursor, actual) {
                (Some(cur), Some(pos)) => {
                    let (lx, ly) = (cur.x - pos.x as f64, cur.y - pos.y as f64);
                    let body_inside = regions.iter().any(|[cx, cy, radius]| {
                        let (cx, cy, radius) = (cx * dpi, cy * dpi, radius * dpi);
                        let (dx, dy) = (lx - cx, ly - cy);
                        dx * dx + dy * dy <= radius * radius
                    });
                    let overlay_inside = overlay_bounds.iter().any(|[x, y, width, height]| {
                        lx >= x * dpi
                            && lx <= (x + width) * dpi
                            && ly >= y * dpi
                            && ly <= (y + height) * dpi
                    });
                    (body_inside, overlay_inside)
                }
                _ => (false, false),
            };

            let mut scale = SCALE_FAR + (SCALE_NEAR - SCALE_FAR) * depth;
            // 角色可见宽度只占窗口的一部分，活动范围按可见宽度算，
            // 这样角色仍然能走到屏幕两侧，而不是被整窗宽度挡住。
            let margin = win_w * scale * dpi * 0.32;
            let min_x = monitor_x + margin;
            let max_x = (monitor_x + monitor_w - margin).max(min_x + 1.0);

            // ---- 拖动：按住角色本体时窗口跟随鼠标 ----
            let button = left_button_down();
            let button_pressed = button && !was_button_down;
            let button_released = !button && was_button_down;
            let right_button = right_button_down();
            let right_button_pressed = right_button && !was_right_button_down;
            was_button_down = button;
            was_right_button_down = right_button;

            // 角色被选中后，每次浮层外的桌面点击都会更新移动终点。
            // 这里只监听系统鼠标状态，不拦截桌面点击，因此其他窗口仍能正常操作。
            if destination_pending && button_pressed && !inside && !overlay_inside {
                if let Some(cur) = cursor {
                    let destination_depth =
                        ((cur.y - horizon_y) / (near_y - horizon_y)).clamp(DEPTH_MIN, DEPTH_MAX);
                    let destination_scale =
                        SCALE_FAR + (SCALE_NEAR - SCALE_FAR) * destination_depth;
                    let destination_margin = win_w * destination_scale * dpi * 0.32;
                    // 终点按角色可见轮廓限制，而不是按整窗限制。窗口里的
                    // 透明留白可以伸出屏幕，脚底中心必须保持可见。
                    let destination_min = monitor_x + destination_margin;
                    let destination_max = monitor_x + monitor_w - destination_margin;
                    target_x = if destination_min <= destination_max {
                        cur.x.clamp(destination_min, destination_max)
                    } else {
                        monitor_x + monitor_w * 0.5
                    };
                    target_depth = destination_depth;
                    // 远处角色虽然会缩小，但窗口本身保持原尺寸。限制脚底高度，
                    // 让缩小后的头顶仍留在屏幕内，而不是只保留脚底可见。
                    let character_height = win_h * dpi * destination_scale * 0.96;
                    let destination_ground_min = monitor_y
                        + win_h * dpi * FOOT_RATIO
                        - character_height
                        + 8.0 * dpi;
                    target_ground_y = cur.y.clamp(destination_ground_min.max(horizon_y), near_y);
                    has_destination = true;
                    rest_until = now;
                    if let Some(state) = app.try_state::<PetState>() {
                        state.walking.store(true, Ordering::Relaxed);
                        state.menu_open.store(false, Ordering::Relaxed);
                    }
                    let _ = app.emit_to("pet", "pet://menu-open", false);
                    walker_log(&format!(
                        "native destination selected: x={:.0} y={:.0} depth={:.2}",
                        target_x, target_ground_y, target_depth
                    ));
                }
            }

            // 透明 WebView 偶尔会漏掉 contextmenu。右键菜单改由系统鼠标状态触发，
            // 这样只要轮廓命中成功，菜单就一定能打开。
            if right_button_pressed && inside && !overlay_inside {
                right_click_started_on_pet = true;
            }
            // 右键点在角色之外（或菜单外）时，取消已经选中的移动目标模式。
            // 同时停止当前移动、关闭角色菜单，避免角色继续走向刚才的目标。
            if right_button_pressed && !inside && !overlay_inside {
                let mut cancelled = false;
                if let Some(state) = app.try_state::<PetState>() {
                    if destination_pending {
                        state.destination_pending.store(false, Ordering::Relaxed);
                        cancelled = true;
                    }
                    if state.walking.load(Ordering::Relaxed) {
                        state.walking.store(false, Ordering::Relaxed);
                        cancelled = true;
                    }
                    if state.menu_open.load(Ordering::Relaxed) {
                        state.menu_open.store(false, Ordering::Relaxed);
                        cancelled = true;
                    }
                }
                if cancelled {
                    let _ = app.emit_to("pet", "pet://destination-mode", false);
                    let _ = app.emit_to("pet", "pet://walking", false);
                    let _ = app.emit_to("pet", "pet://menu-open", false);
                    walker_log("pet interaction cancelled by outside right click");
                }
            }
            if !right_button && was_right_button_down && right_click_started_on_pet {
                if let Some(state) = app.try_state::<PetState>() {
                    state.menu_open.store(true, Ordering::Relaxed);
                    state.destination_pending.store(false, Ordering::Relaxed);
                    state.walking.store(false, Ordering::Relaxed);
                }
                let _ = app.emit_to("pet", "pet://menu-open", true);
                let _ = app.emit_to("pet", "pet://destination-mode", false);
                let _ = app.emit_to("pet", "pet://walking", false);
                walker_log("native pet menu opened");
                right_click_started_on_pet = false;
            }

            // 左键选点同样在桌面壳完成。按下时只记录起点，松开且没有拖动才进入
            // “等待下一次桌面点击”的模式，避免和按住拖动窗口互相干扰。
            if button_pressed && inside && !overlay_inside {
                left_click_started_on_pet = true;
                left_click_origin = cursor.map(|cur| (cur.x, cur.y));
            }
            if button_released {
                if left_click_started_on_pet {
                    let moved = match (left_click_origin, cursor) {
                        (Some((sx, sy)), Some(cur)) => {
                            ((cur.x - sx).powi(2) + (cur.y - sy).powi(2)).sqrt()
                        }
                        _ => f64::INFINITY,
                    };
                    if !left_dragged && moved <= 7.0 * dpi {
                        if let Some(state) = app.try_state::<PetState>() {
                            state.destination_pending.store(true, Ordering::Relaxed);
                            state.menu_open.store(false, Ordering::Relaxed);
                            state.walking.store(false, Ordering::Relaxed);
                        }
                        let _ = app.emit_to("pet", "pet://menu-open", false);
                        let _ = app.emit_to("pet", "pet://destination-mode", true);
                        let _ = app.emit_to("pet", "pet://walking", false);
                        walker_log("native pet click selected; waiting for destination");
                    }
                }
                left_click_started_on_pet = false;
                left_click_origin = None;
                left_dragged = false;
            }

            if !dragging && button && inside && !overlay_inside && !right_button {
                if let (Some(cur), Some(pos)) = (cursor, actual) {
                    dragging = true;
                    drag_start_cursor = Some((cur.x, cur.y));
                    drag_start_window = Some((pos.x as f64, pos.y as f64));
                }
            }

            if dragging {
                if button {
                    if let (Some((scx, scy)), Some((swx, swy)), Some(cur)) =
                        (drag_start_cursor, drag_start_window, cursor)
                    {
                        let nx = swx + (cur.x - scx);
                        let ny = swy + (cur.y - scy);
                        if window
                            .set_position(tauri::PhysicalPosition::new(
                                nx.round() as i32,
                                ny.round() as i32,
                            ))
                            .is_ok()
                        {
                            expected_position = Some((nx.round(), ny.round()));
                        }
                        if (cur.x - scx).abs() > 1.0 {
                            direction = (cur.x - scx).signum();
                        }
                        if (cur.x - scx).abs() > 4.0 * dpi || (cur.y - scy).abs() > 4.0 * dpi {
                            left_dragged = true;
                        }
                        // 窗口尺寸固定，脚底中心就是窗口水平中点
                        x = nx + win_w * dpi * 0.5;
                        rest_until = now + Duration::from_millis(900);
                    }
                } else {
                    dragging = false;
                    drag_start_cursor = None;
                    drag_start_window = None;
                    // 松手后按脚底所在高度重新推算深度：角色落在哪个高度，
                    // 就站在地面上的哪个远近位置，尺寸随之调整
                    if let Some(pos) = actual {
                        let ground = pos.y as f64 + win_h * dpi * FOOT_RATIO;
                        depth =
                            ((ground - horizon_y) / (near_y - horizon_y)).clamp(DEPTH_MIN, DEPTH_MAX);
                        target_depth = depth;
                        target_x = x;
                        ground_y = ground;
                        target_ground_y = ground;
                        has_destination = false;
                        if let Some(state) = app.try_state::<PetState>() {
                            state.walking.store(false, Ordering::Relaxed);
                        }
                        let _ = app.emit_to("pet", "pet://walking", false);
                    }
                    rest_until = now + Duration::from_millis(1400);
                }
            }

            let resting = now < rest_until;
            // 拖动期间不动，避免和鼠标抢位置
            let moving = walking && has_destination && !resting && !dragging;

            if moving {
                // 地面速度固定，屏幕位移随显示比例缩放：
                // 角色变小时位移同步变慢，和腿部步幅保持一致，所以不会滑步
                // 窗口高度相对基准 620 变化时，每世界单位对应的像素数同比变化，
                // 所以速度也要跟着缩放，否则用户改过窗口大小就会滑步。
                let step = GROUND_SPEED * dpi * (win_h / BASE_HEIGHT) * scale * delta;
                let dx = target_x - x;
                let vertical = target_ground_y - ground_y;
                let distance = (dx * dx + vertical * vertical).sqrt();
                if distance <= step.max(0.5) {
                    x = target_x;
                    ground_y = target_ground_y;
                    depth = target_depth;
                    has_destination = false;
                    if let Some(state) = app.try_state::<PetState>() {
                        state.walking.store(false, Ordering::Relaxed);
                    }
                    let _ = app.emit_to("pet", "pet://walking", false);
                } else {
                    x += dx / distance * step;
                    ground_y += vertical / distance * step;
                    // 屏幕位置按真实点击点插值；视觉大小按“离终点还有多远”
                    // 平滑靠近目标，不把缩放后的脚底高度反写回窗口位置。
                    let remaining = ((target_x - x).powi(2)
                        + (target_ground_y - ground_y).powi(2))
                    .sqrt();
                    let travel = (remaining + distance).max(1.0);
                    depth = (depth + (target_depth - depth) * (step / travel))
                        .clamp(DEPTH_MIN, DEPTH_MAX);
                    scale = SCALE_FAR + (SCALE_NEAR - SCALE_FAR) * depth;
                    if dx.abs() > 0.5 {
                        direction = dx.signum();
                    }
                }
            }

            // 深度可能刚变过，按最新深度重新算尺寸与落点。
            // 拖动期间位置已经由鼠标决定，不再按地面公式覆盖。
            if !dragging {
                x = x.clamp(min_x, max_x);
                ground_y = ground_y.clamp(horizon_y, near_y);
                // 窗口尺寸固定不动，只有位置在变。透明窗口每帧 resize 会闪，
                // 这里只做 set_position，重绘代价可以忽略。
                let win_x = (x - win_w * dpi * 0.5).round();
                let win_y = (ground_y - win_h * dpi * FOOT_RATIO).round();

                let position_changed = expected_position
                    .map(|(ex, ey)| (win_x - ex).abs() > 0.5 || (win_y - ey).abs() > 0.5)
                    .unwrap_or(true);
                if position_changed
                    && window
                        .set_position(tauri::PhysicalPosition::new(win_x as i32, win_y as i32))
                        .is_ok()
                {
                    expected_position = Some((win_x, win_y));
                }
            }

            if inside || overlay_inside || dragging {
                interactive_until = now + Duration::from_millis(650);
            }
            // 拖动期间保持可交互，否则鼠标快速移动时会中途丢掉窗口
            let want_click_through =
                !inside && !overlay_inside && !dragging && now > interactive_until;
            if click_through != Some(want_click_through)
                && window.set_ignore_cursor_events(want_click_through).is_ok()
            {
                click_through = Some(want_click_through);
            }

            // 步态广播：状态变化立刻发，其余按 4Hz 更新深度
            let dir_i32 = if direction >= 0.0 { 1 } else { -1 };
            let changed = announced_walking != Some(moving) || announced_direction != dir_i32;
            if changed || now.duration_since(announced_at) > Duration::from_millis(250) {
                announced_walking = Some(moving);
                announced_direction = dir_i32;
                announced_at = now;
                let _ = app.emit_to(
                    "pet",
                    "pet://gait",
                    GaitPayload {
                        walking: moving,
                        direction: dir_i32,
                        depth,
                        speed: scale,
                    },
                );
                if changed {
                    let _ = app.emit_to("pet", "pet://walk-direction", dir_i32);
                }
            }
                }
            }));
            if tick.is_err() {
                walker_log("walker tick panicked; recovered on next frame");
            }
        }
    });
}

fn main() {
    walker_log("application process starting");
    // 后台走动线程出错时不会弹窗，统一写进日志文件，方便排查"角色卡住不动"
    let previous_hook = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        walker_log(&format!("PANIC: {info}"));
        previous_hook(info);
    }));

    tauri::Builder::default()
        .manage(PetState::default())
        .plugin(tauri_plugin_shell::init())
        .plugin(
            tauri_plugin_window_state::Builder::default()
                // 桌宠位置由走动线程实时计算。恢复旧坐标会把角色放到屏幕外，
                // 或让它与走动线程争夺位置；主窗口仍保留自己的窗口状态。
                .with_denylist(&["pet"])
                .build(),
        )
        .on_window_event(|window, event| {
            // 关闭主窗口时只隐藏，保留 WebView 和聊天状态，供托盘随时恢复。
            if window.label() == "main" {
                if let WindowEvent::CloseRequested { api, .. } = event {
                    api.prevent_close();
                    let _ = window.hide();
                    walker_log("main window hidden from close request");
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            ensure_pet_window,
            set_click_through,
            toggle_always_on_top,
            show_main_window,
            open_pet_chat,
            hide_pet_chat,
            focus_pet,
            get_pet_walking,
            set_pet_walking,
            set_pet_hit_regions,
            set_pet_menu_open,
            set_pet_overlay_bounds,
            set_pet_destination_mode,
            quit_app
        ])
        .setup(|app| {
            walker_log("application setup started");
            spawn_pet_walker(app.handle().clone());

            // 托盘菜单：主窗口 / 角色窗口 / 退出
            let show_main = MenuItem::with_id(app, "show_main", "显示主窗口", true, None::<&str>)?;
            let show_pet = MenuItem::with_id(app, "show_pet", "显示角色", true, None::<&str>)?;
            let hide_pet = MenuItem::with_id(app, "hide_pet", "隐藏角色", true, None::<&str>)?;
            let show_chat = MenuItem::with_id(app, "show_chat", "显示聊天", true, None::<&str>)?;
            let walk_start =
                MenuItem::with_id(app, "walk_start", "选择移动位置", true, None::<&str>)?;
            let walk_stop = MenuItem::with_id(app, "walk_stop", "原地待机", true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "退出", true, None::<&str>)?;
            let menu = Menu::with_items(
                app,
                &[
                    &show_main,
                    &show_pet,
                    &hide_pet,
                    &show_chat,
                    &walk_start,
                    &walk_stop,
                    &quit,
                ],
            )?;

            TrayIconBuilder::with_id("main-tray")
                .icon(app.default_window_icon().expect("缺少应用图标").clone())
                .tooltip("陪伴智能体")
                .menu(&menu)
                .show_menu_on_left_click(false)
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "show_main" => {
                        if let Err(error) = show_main_window_impl(app) {
                            walker_log(&format!("tray main window show failed: {error}"));
                        }
                    }
                    "show_pet" => {
                        if let Some(window) = app.get_webview_window("pet") {
                            let _ = window.show();
                        } else if let Err(error) = create_pet_window(app) {
                            walker_log(&format!("tray pet window creation failed: {error}"));
                        }
                    }
                    "hide_pet" => {
                        if let Some(window) = app.get_webview_window("pet") {
                            let _ = window.hide();
                        }
                    }
                    "show_chat" => {
                        if let Err(error) = open_pet_chat(app.clone()) {
                            walker_log(&format!("tray chat window open failed: {error}"));
                        }
                    }
                    "walk_start" | "walk_stop" => {
                        let selecting = event.id.as_ref() == "walk_start";
                        if let Some(state) = app.try_state::<PetState>() {
                            state.destination_pending.store(selecting, Ordering::Relaxed);
                            state.menu_open.store(false, Ordering::Relaxed);
                            if !selecting {
                                state.walking.store(false, Ordering::Relaxed);
                            }
                        }
                        let _ = app.emit_to("pet", "pet://menu-open", false);
                        let _ = app.emit_to("pet", "pet://destination-mode", selecting);
                        if !selecting {
                            let _ = app.emit_to("pet", "pet://walking", false);
                        }
                    }
                    "quit" => app.exit(0),
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    // 左键单击托盘图标时唤出主窗口
                    if let tauri::tray::TrayIconEvent::Click {
                        button: tauri::tray::MouseButton::Left,
                        button_state: tauri::tray::MouseButtonState::Up,
                        ..
                    } = event
                    {
                        let app = tray.app_handle();
                        if let Err(error) = show_main_window_impl(app) {
                            walker_log(&format!("tray main window show failed: {error}"));
                        }
                    }
                })
                .build(app)?;
            walker_log("tray initialized");

            // 必须在 setup 阶段创建第二个 WebView2。把它推迟到页面脚本里
            // 会与主 WebView 的初始化争用，导致角色窗口永久"未响应"。
            match ensure_pet_window_impl(app.handle()) {
                Ok(created) => walker_log(if created {
                    "pet window created during setup"
                } else {
                    "pet window already exists during setup"
                }),
                Err(error) => {
                    // 角色窗口若与主窗口争用 WebView2 环境，不应拖垮整个应用。
                    // 由下方延迟兜底再试，主聊天窗口仍能正常使用。
                    walker_log(&format!("pet window setup creation failed: {error}"));
                }
            }
            // 独立聊天窗口必须在启动阶段、非 IPC 回调里创建。若等到用户点
            // “聊天框”时再从命令内创建第二个 WebView2，Windows 上会卡在
            // WebviewWindowBuilder::build()，表现为菜单点了但没有窗口。
            if app.get_webview_window("chat").is_none() {
                match create_chat_window(app.handle()) {
                    Ok(_) => walker_log("chat window prepared hidden during setup"),
                    Err(error) => {
                        walker_log(&format!("chat window setup creation failed: {error}"))
                    }
                }
            } else {
                walker_log("chat window already exists during setup");
            }
            schedule_pet_window(app.handle().clone());
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("启动桌面应用失败");
}
