//! Hide WebView2's "<origin> is sharing your screen" bar (Windows only).
//!
//! WebView2 floats its own bar over the desktop for every screen capture and
//! names the page origin on it. In the installed app that origin is the Tauri
//! protocol host, `tauri.localhost`, which means nothing to the user (under
//! `tauri dev` it is the Vite host). WebView2 has no setting for the bar, its
//! `ScreenCaptureStarting` event can only allow or cancel the capture, and the
//! origin itself cannot change: the E2E vault lives in that origin's IndexedDB.
//! So, like other desktop clients, the app hides the bar's window once it
//! appears; the share panel keeps its own stop control and shows the live state.
//!
//! The match is strict and never relaxed to the title alone: the window must
//! belong to the WebView2 browser process, be visible, be no taller than a bar
//! and carry the app's host in its title. Anything else is never touched, and
//! when nothing matches the bar stays and one log line says so.

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use webview2_com::Microsoft::Web::WebView2::Win32::{
    ICoreWebView2, ICoreWebView2ScreenCaptureStartingEventArgs, ICoreWebView2_27,
};
use webview2_com::ScreenCaptureStartingEventHandler;
use windows_core::Interface;
use windows_sys::core::BOOL;
use windows_sys::Win32::Foundation::{HWND, LPARAM, RECT};
use windows_sys::Win32::UI::WindowsAndMessaging::{
    EnumWindows, GetWindowRect, GetWindowTextW, GetWindowThreadProcessId, IsWindowVisible,
    ShowWindowAsync, SW_HIDE,
};

/// Anything taller is not a bar (the source picker, a dialog) and is never touched. Physical pixels.
const MAX_BAR_HEIGHT: i32 = 240;
/// The bar appears only after the user confirms the picker, which can stay open a while.
const WATCH_FOR: Duration = Duration::from_secs(120);
const POLL_EVERY: Duration = Duration::from_millis(150);

/// The host the bar names: the dev server's in a debug build, the Tauri protocol host otherwise.
pub fn app_host(config: &tauri::Config) -> String {
    host_of(config.build.dev_url.as_ref(), cfg!(debug_assertions))
}

fn host_of(dev_url: Option<&tauri::Url>, debug: bool) -> String {
    if debug {
        if let Some(host) = dev_url.and_then(|u| u.host_str()) {
            return host.to_string();
        }
    }
    "tauri.localhost".to_string()
}

/// The title and size conditions; the caller has already matched the process and the visibility.
fn is_share_bar(title: &str, height: i32, host: &str) -> bool {
    !host.is_empty() && height > 0 && height <= MAX_BAR_HEIGHT && title.contains(host)
}

/// Register the hide on this window's webview. Never fails the app: every refusal is one log line.
pub fn hide_on_capture(window: &tauri::WebviewWindow, host: String) {
    let dispatched = window.with_webview(move |webview| {
        if let Err(err) = register(&webview, host) {
            eprintln!("[Voxium] Screen-share bar: not hidden ({err}); the WebView2 bar stays");
        }
    });
    if let Err(err) = dispatched {
        eprintln!("[Voxium] Screen-share bar: webview unavailable ({err}); the WebView2 bar stays");
    }
}

fn register(webview: &tauri::webview::PlatformWebview, host: String) -> Result<(), String> {
    // SAFETY: COM calls on the webview thread, which is where with_webview runs us.
    let core =
        unsafe { webview.controller().CoreWebView2() }.map_err(|e| format!("CoreWebView2: {e}"))?;
    let mut pid = 0u32;
    unsafe { core.BrowserProcessId(&mut pid) }.map_err(|e| format!("BrowserProcessId: {e}"))?;
    if pid == 0 {
        return Err("browser process id is 0".to_string());
    }
    // ScreenCaptureStarting arrived with ICoreWebView2_27 (runtime 1.0.2903+); an older runtime keeps the bar.
    let core27 = core
        .cast::<ICoreWebView2_27>()
        .map_err(|e| format!("WebView2 runtime without ScreenCaptureStarting: {e}"))?;

    let latest = Arc::new(AtomicU64::new(0));
    let handler = ScreenCaptureStartingEventHandler::create(Box::new(
        move |_sender: Option<ICoreWebView2>,
              _args: Option<ICoreWebView2ScreenCaptureStartingEventArgs>| {
            // Each capture gets its own watch; a newer capture supersedes an older one.
            // The capture itself is never cancelled or marked handled here.
            let generation = latest.fetch_add(1, Ordering::SeqCst) + 1;
            let latest = Arc::clone(&latest);
            let host = host.clone();
            let spawned = std::thread::Builder::new()
                .name("share-bar-watch".to_string())
                .spawn(move || watch(pid, &host, &latest, generation));
            if let Err(err) = spawned {
                eprintln!("[Voxium] Screen-share bar: watcher not started ({err}); the WebView2 bar stays");
            }
            Ok(())
        },
    ));
    let mut token = 0i64;
    unsafe { core27.add_ScreenCaptureStarting(&handler, &mut token) }
        .map_err(|e| format!("add_ScreenCaptureStarting: {e}"))?;
    // The token is dropped on purpose: the handler lives as long as the window.
    Ok(())
}

enum Outcome {
    Hidden,
    /// Nothing matched; the visible windows of the browser process, for the log line.
    NotFound(Vec<String>),
}

fn watch(pid: u32, host: &str, latest: &AtomicU64, generation: u64) {
    let deadline = Instant::now() + WATCH_FOR;
    let mut seen: Vec<String> = Vec::new();
    while Instant::now() < deadline && latest.load(Ordering::SeqCst) == generation {
        match hide_share_bar(pid, host) {
            Outcome::Hidden => return,
            Outcome::NotFound(windows) => seen = windows,
        }
        std::thread::sleep(POLL_EVERY);
    }
    if latest.load(Ordering::SeqCst) == generation {
        // A cancelled picker ends here too (no bar ever appeared): harmless, one line.
        let seen = if seen.is_empty() {
            "none".to_string()
        } else {
            seen.join(", ")
        };
        eprintln!(
            "[Voxium] Screen-share bar: no matching window within {}s; the WebView2 bar stays (visible windows of the browser process: {seen})",
            WATCH_FOR.as_secs()
        );
    }
}

struct Search {
    pid: u32,
    host: String,
    hidden: bool,
    seen: Vec<String>,
}

fn hide_share_bar(pid: u32, host: &str) -> Outcome {
    let mut search = Search {
        pid,
        host: host.to_string(),
        hidden: false,
        seen: Vec::new(),
    };
    // SAFETY: `visit` reads `search` through the LPARAM for the duration of this call only.
    unsafe { EnumWindows(Some(visit), &mut search as *mut Search as LPARAM) };
    if search.hidden {
        Outcome::Hidden
    } else {
        Outcome::NotFound(search.seen)
    }
}

unsafe extern "system" fn visit(hwnd: HWND, lparam: LPARAM) -> BOOL {
    // SAFETY: the LPARAM is the `Search` that `hide_share_bar` owns for the whole enumeration.
    let search = unsafe { &mut *(lparam as *mut Search) };
    let mut pid = 0u32;
    unsafe { GetWindowThreadProcessId(hwnd, &mut pid) };
    if pid != search.pid || unsafe { IsWindowVisible(hwnd) } == 0 {
        return 1;
    }
    let mut rect = RECT {
        left: 0,
        top: 0,
        right: 0,
        bottom: 0,
    };
    if unsafe { GetWindowRect(hwnd, &mut rect) } == 0 {
        return 1;
    }
    let mut buf = [0u16; 512];
    let len = unsafe { GetWindowTextW(hwnd, buf.as_mut_ptr(), buf.len() as i32) };
    let title = String::from_utf16_lossy(&buf[..len.max(0) as usize]);
    let height = rect.bottom - rect.top;
    if is_share_bar(&title, height, &search.host) {
        // Async: a busy browser process must not stall the watcher thread.
        unsafe { ShowWindowAsync(hwnd, SW_HIDE) };
        search.hidden = true;
    } else {
        search.seen.push(format!("{title:?} ({height}px)"));
    }
    1 // keep enumerating: every matching window is hidden
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn matches_the_bar_in_any_language_by_host_and_height() {
        assert!(is_share_bar(
            "http://tauri.localhost is sharing your screen.",
            48,
            "tauri.localhost"
        ));
        assert!(is_share_bar(
            "http://tauri.localhost partage votre écran.",
            46,
            "tauri.localhost"
        ));
        // the dev build names the Vite host; a scaled display makes the bar taller
        assert!(is_share_bar(
            "localhost:8080 is sharing your screen.",
            96,
            "localhost"
        ));
        assert!(is_share_bar(
            "http://tauri.localhost is sharing your screen.",
            MAX_BAR_HEIGHT,
            "tauri.localhost"
        ));
    }

    #[test]
    fn never_matches_the_picker_another_window_or_an_empty_host() {
        // the source picker and the app window are far taller than a bar
        assert!(!is_share_bar(
            "http://tauri.localhost is sharing your screen.",
            MAX_BAR_HEIGHT + 1,
            "tauri.localhost"
        ));
        assert!(!is_share_bar("Voxium", 48, "tauri.localhost"));
        assert!(!is_share_bar("", 48, "tauri.localhost"));
        assert!(!is_share_bar(
            "http://tauri.localhost is sharing your screen.",
            0,
            "tauri.localhost"
        ));
        assert!(!is_share_bar(
            "http://tauri.localhost is sharing your screen.",
            -1,
            "tauri.localhost"
        ));
        // an empty host would match every short window of the browser process
        assert!(!is_share_bar(
            "http://tauri.localhost is sharing your screen.",
            48,
            ""
        ));
    }

    #[test]
    fn the_host_is_the_dev_server_in_debug_and_the_tauri_protocol_host_otherwise() {
        let dev = tauri::Url::parse("http://localhost:8080").unwrap();
        assert_eq!(host_of(Some(&dev), true), "localhost");
        assert_eq!(host_of(Some(&dev), false), "tauri.localhost");
        assert_eq!(host_of(None, true), "tauri.localhost");
        assert_eq!(host_of(None, false), "tauri.localhost");
    }
}
