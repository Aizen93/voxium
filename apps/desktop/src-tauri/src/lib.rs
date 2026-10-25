use std::io::Read;

/// Strict regex matching the server's VALID_S3_KEY_RE: (avatars|server-icons)/[word-dash]+.webp
/// Prevents path traversal, null bytes, and unexpected characters in the key.
fn is_valid_avatar_key(key: &str) -> bool {
    // Reject null bytes, control characters, and excessive length
    if key.len() > 128 || key.bytes().any(|b| b < 0x20) {
        return false;
    }
    // Must match: ^(avatars|server-icons)/[\w-]+\.webp$
    let (prefix, rest) = if let Some(r) = key.strip_prefix("avatars/") {
        ("avatars/", r)
    } else if let Some(r) = key.strip_prefix("server-icons/") {
        ("server-icons/", r)
    } else {
        return false;
    };
    let _ = prefix;
    let Some(name) = rest.strip_suffix(".webp") else {
        return false;
    };
    !name.is_empty() && name.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
}

/// Download an avatar image to the temp directory and return the file path.
/// Validates key against the strict S3 key regex, image magic bytes, and 1 MB size limit.
fn cache_avatar_to_file(api_base: &str, key: &str) -> Result<std::path::PathBuf, String> {
    if !is_valid_avatar_key(key) {
        return Err("Invalid avatar key".to_string());
    }
    if !api_base.starts_with("http://") && !api_base.starts_with("https://") {
        return Err("Invalid API base URL".to_string());
    }

    let temp_dir = std::env::temp_dir().join("voxium_avatars");
    // Replace all non-alphanumeric/dot/dash/underscore chars for safe filenames on all OSes
    let safe_name: String = key
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() || c == '.' || c == '-' || c == '_' { c } else { '_' })
        .collect();
    let path = temp_dir.join(&safe_name);

    // Verify cached file is a regular file (not a symlink planted by another process)
    if path.exists() {
        if path.is_file() && !path.is_symlink() {
            return Ok(path);
        }
        // Suspicious entry — remove it and re-download
        let _ = std::fs::remove_file(&path);
    }

    let url = format!("{}/uploads/{}", api_base.trim_end_matches('/'), key);
    let response = ureq::get(&url)
        .timeout(std::time::Duration::from_secs(10))
        .call()
        .map_err(|_| "Avatar download failed".to_string())?;

    let mut bytes = Vec::new();
    response
        .into_reader()
        .take(1_048_577)
        .read_to_end(&mut bytes)
        .map_err(|_| "Avatar read failed".to_string())?;

    if bytes.len() > 1_048_576 {
        return Err("Avatar too large".to_string());
    }
    if !is_valid_image(&bytes) {
        return Err("Invalid image data".to_string());
    }

    std::fs::create_dir_all(&temp_dir).map_err(|e| e.to_string())?;
    std::fs::write(&path, &bytes).map_err(|_| "Failed to cache avatar".to_string())?;
    Ok(path)
}

fn is_valid_image(bytes: &[u8]) -> bool {
    if bytes.len() < 4 {
        return false;
    }
    bytes.starts_with(&[0x89, 0x50, 0x4E, 0x47])       // PNG
        || bytes.starts_with(&[0xFF, 0xD8, 0xFF])       // JPEG
        || (bytes.len() >= 12
            && bytes.starts_with(b"RIFF")
            && &bytes[8..12] == b"WEBP")                 // WebP
        || bytes.starts_with(b"GIF8")                    // GIF
}

/// Resolve the Windows app identity for toast notifications.
/// In dev mode (exe in target/debug or target/release), uses PowerShell's AUMID
/// as the standard workaround. In production (installed app), uses the Tauri identifier.
#[cfg(target_os = "windows")]
fn get_windows_app_id(app: &tauri::AppHandle) -> String {
    use std::path::MAIN_SEPARATOR as SEP;

    if let Ok(exe) = std::env::current_exe() {
        if let Some(parent) = exe.parent() {
            let dir = parent.display().to_string();
            if !dir.ends_with(&format!("{SEP}target{SEP}debug"))
                && !dir.ends_with(&format!("{SEP}target{SEP}release"))
            {
                return app.config().identifier.clone();
            }
        }
    }

    tauri_winrt_notification::Toast::POWERSHELL_APP_ID.to_string()
}

/// Show a native OS notification with an optional avatar image.
/// On Windows: uses WinRT toast with a circular avatar in the app logo position.
/// On other platforms: returns Err so the JS side falls through to the Tauri plugin / Web API.
#[tauri::command]
fn notify_with_avatar(
    app: tauri::AppHandle,
    title: String,
    body: String,
    api_base: Option<String>,
    avatar_key: Option<String>,
) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        use tauri_winrt_notification::{IconCrop, Toast};

        let app_id = get_windows_app_id(&app);
        let mut toast = Toast::new(&app_id).title(&title).text2(&body);

        if let (Some(base), Some(key)) = (&api_base, &avatar_key) {
            if let Ok(path) = cache_avatar_to_file(base, key) {
                toast = toast.icon(&path, IconCrop::Circular, "");
            }
        }

        toast.show().map_err(|e| format!("{e:?}"))?;
        return Ok(());
    }

    #[cfg(not(target_os = "windows"))]
    {
        let _ = (app, title, body, api_base, avatar_key);
        Err("Avatar notifications not implemented on this platform".to_string())
    }
}

// ─── E2E pickle key in the OS keychain (docs/e2e-dm-spec.md §7.3) ────────────
// The 32-byte vodozemac pickle key is the one secret the webview handles.
// These commands move it from localStorage into the platform credential store
// (Windows Credential Manager / macOS Keychain / Linux Secret Service). The
// service name is hardcoded server-side of the IPC boundary so webview code
// can only ever touch Voxium's own E2E entries.

const E2E_KEYCHAIN_SERVICE: &str = "app.voxium.e2e-pickle-key";

fn valid_e2e_user_id(user_id: &str) -> bool {
    !user_id.is_empty()
        && user_id.len() <= 64
        && user_id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

#[tauri::command]
fn e2e_pickle_key_get(user_id: String) -> Result<Option<String>, String> {
    if !valid_e2e_user_id(&user_id) {
        return Err("invalid user id".to_string());
    }
    let entry = keyring::Entry::new(E2E_KEYCHAIN_SERVICE, &user_id).map_err(|e| e.to_string())?;
    match entry.get_password() {
        Ok(value) => Ok(Some(value)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(e.to_string()),
    }
}

#[tauri::command]
fn e2e_pickle_key_set(user_id: String, key_b64: String) -> Result<(), String> {
    if !valid_e2e_user_id(&user_id) {
        return Err("invalid user id".to_string());
    }
    // exactly one 32-byte base64 key (43 unpadded / 44 padded chars)
    let valid_shape = (key_b64.len() == 43 || key_b64.len() == 44)
        && key_b64
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '+' || c == '/' || c == '=');
    if !valid_shape {
        return Err("invalid key format".to_string());
    }
    let entry = keyring::Entry::new(E2E_KEYCHAIN_SERVICE, &user_id).map_err(|e| e.to_string())?;
    entry.set_password(&key_b64).map_err(|e| e.to_string())
}

// ─── Session credentials in the OS keychain ──────────────────────────────────
// The signed-in session ("Remember me": the access + refresh token pair) and
// the trusted-device token (skips TOTP for 30 days) are bearer credentials.
// They used to sit in the webview's localStorage — a plaintext LevelDB under
// the user's profile, copied into every backup and readable by anything that
// can read the user's files — and now live in the platform credential store,
// like the pickle key above: encrypted at rest under the OS user's login
// (macOS also gates access per application; Windows and the Secret Service
// grant it to the user's processes). The same shape as the pickle key: a
// fixed service name and a closed set of entry names on the Rust side of the
// IPC boundary, so webview code can only ever reach Voxium's own entries, and
// a value is shape-checked before it is written. The webview side is
// services/tokenStorage.ts (`createKeychainSessionStore`).

const SESSION_KEYCHAIN_SERVICE: &str = "app.voxium.session";
const SESSION_SECRET_NAMES: &[&str] = &["tokens", "trusted-device"];
/// Windows caps a generic credential's blob at 2560 bytes and the keyring
/// crate stores a password as UTF-16: 1280 code units. Two JWTs in the JSON
/// pair the webview writes are ~600 ASCII characters; anything past this cap
/// is a bug, not a credential.
const SESSION_SECRET_MAX_CHARS: usize = 1280;

fn session_entry(name: &str) -> Result<keyring::Entry, String> {
    if !SESSION_SECRET_NAMES.contains(&name) {
        return Err("unknown credential".to_string());
    }
    keyring::Entry::new(SESSION_KEYCHAIN_SERVICE, name).map_err(|e| e.to_string())
}

/// Printable ASCII without spaces, bounded: a JWT (base64url and dots) or the
/// JSON pair the webview wraps two of them in. Nothing else is ours to store.
fn valid_session_secret_value(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= SESSION_SECRET_MAX_CHARS
        && value.bytes().all(|b| (0x21..=0x7e).contains(&b))
}

/// The stored value, `None` when there is no such entry.
fn read_session_secret(name: &str) -> Result<Option<String>, String> {
    match session_entry(name)?.get_password() {
        Ok(value) => Ok(Some(value)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(e.to_string()),
    }
}

fn write_session_secret(name: &str, value: &str) -> Result<(), String> {
    if !valid_session_secret_value(value) {
        return Err("invalid credential format".to_string());
    }
    session_entry(name)?.set_password(value).map_err(|e| e.to_string())
}

/// Removing an entry that is not there is the state the caller asked for.
fn delete_session_secret(name: &str) -> Result<(), String> {
    match session_entry(name)?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(e.to_string()),
    }
}

// The keyring calls block (Credential Manager, the Keychain, a D-Bus round
// trip to the Secret Service): they run on the blocking pool, off the thread
// that paints the window.

#[tauri::command]
async fn session_secret_get(name: String) -> Result<Option<String>, String> {
    tauri::async_runtime::spawn_blocking(move || read_session_secret(&name))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn session_secret_set(name: String, value: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || write_session_secret(&name, &value))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn session_secret_delete(name: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || delete_session_secret(&name))
        .await
        .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod session_secret_tests {
    use super::*;

    /// Every test in this binary shares the process-wide default builder:
    /// the in-memory mock store, never the machine's own credential store.
    fn use_mock_store() {
        static ONCE: std::sync::Once = std::sync::Once::new();
        ONCE.call_once(|| keyring::set_default_credential_builder(keyring::mock::default_credential_builder()));
    }

    #[test]
    fn only_the_known_entry_names_resolve() {
        use_mock_store();
        assert!(session_entry("tokens").is_ok());
        assert!(session_entry("trusted-device").is_ok());
        for name in ["", "token", "Tokens", "../tokens", "e2e-pickle-key", "alice"] {
            assert_eq!(session_entry(name).unwrap_err(), "unknown credential", "{name:?}");
            assert_eq!(read_session_secret(name).unwrap_err(), "unknown credential");
            assert_eq!(write_session_secret(name, "abc").unwrap_err(), "unknown credential");
            assert_eq!(delete_session_secret(name).unwrap_err(), "unknown credential");
        }
    }

    #[test]
    fn a_missing_entry_reads_as_none_and_deletes_as_ok() {
        use_mock_store();
        // the two entries are independent: this one is never written here
        assert_eq!(read_session_secret("trusted-device"), Ok(None));
        assert_eq!(delete_session_secret("trusted-device"), Ok(()));
        assert_eq!(read_session_secret("trusted-device"), Ok(None));
    }

    /// The mock store holds one credential PER `Entry` (no shared table), so a
    /// round trip across two helper calls cannot be observed here; it was
    /// exercised against the real Windows Credential Manager (set, read back,
    /// overwrite, delete, read after delete, two independent entry names)
    /// when this landed. What the mock does show: the pair the webview writes
    /// passes the shape check and a write of it succeeds.
    #[test]
    fn the_pair_the_webview_writes_is_accepted() {
        use_mock_store();
        let pair = r#"{"accessToken":"eyJhbGciOiJIUzI1NiJ9.a.b","refreshToken":"eyJhbGciOiJIUzI1NiJ9.c.d"}"#;
        assert_eq!(write_session_secret("tokens", pair), Ok(()));
        assert_eq!(write_session_secret("trusted-device", "eyJhbGciOiJIUzI1NiJ9.a.b"), Ok(()));
        // a second delete is still the state the caller asked for
        assert_eq!(delete_session_secret("tokens"), Ok(()));
        assert_eq!(delete_session_secret("tokens"), Ok(()));
    }

    #[test]
    fn a_malformed_value_is_refused_before_the_store_is_touched() {
        use_mock_store();
        for bad in ["", "with space", "héllo", &"a".repeat(SESSION_SECRET_MAX_CHARS + 1)] {
            assert_eq!(write_session_secret("tokens", bad).unwrap_err(), "invalid credential format");
        }
        assert_eq!(read_session_secret("tokens"), Ok(None));
    }

    #[test]
    fn a_value_is_bounded_printable_ascii_without_spaces() {
        let jwt = "eyJhbGciOiJIUzI1NiJ9.eyJ1c2VySWQiOiJjbHgxIn0.abc-_DEF";
        assert!(valid_session_secret_value(jwt));
        assert!(valid_session_secret_value(&format!(
            "{{\"accessToken\":\"{jwt}\",\"refreshToken\":\"{jwt}\"}}"
        )));
        assert!(valid_session_secret_value(&"a".repeat(SESSION_SECRET_MAX_CHARS)));

        assert!(!valid_session_secret_value(""));
        assert!(!valid_session_secret_value(&"a".repeat(SESSION_SECRET_MAX_CHARS + 1)));
        assert!(!valid_session_secret_value("with space"));
        assert!(!valid_session_secret_value("line\nbreak"));
        assert!(!valid_session_secret_value("nul\0byte"));
        assert!(!valid_session_secret_value("héllo"));
        assert!(!valid_session_secret_value("\u{7f}"));
    }
}

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .invoke_handler(tauri::generate_handler![
            notify_with_avatar,
            e2e_pickle_key_get,
            e2e_pickle_key_set,
            session_secret_get,
            session_secret_set,
            session_secret_delete
        ])
        .setup(|app| {
            use tauri::Manager;

            // System tray with "Show" and "Quit" menu
            // On Linux (GNOME/Wayland), tray creation can fail if libappindicator
            // or a StatusNotifierItem D-Bus service is not available. We must handle
            // this gracefully so the app still works without a system tray.
            use tauri::menu::{Menu, MenuItem};
            use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};

            let show_item = MenuItem::with_id(app, "show", "Show Voxium", true, None::<&str>)?;
            let quit_item = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&show_item, &quit_item])?;

            let has_tray = TrayIconBuilder::new()
                .icon(app.default_window_icon().unwrap().clone())
                .tooltip("Voxium")
                .menu(&menu)
                .on_menu_event(|app, event| {
                    match event.id.as_ref() {
                        "show" => {
                            if let Some(window) = app.get_webview_window("main") {
                                let _ = window.show();
                                let _ = window.unminimize();
                                let _ = window.set_focus();
                            }
                        }
                        "quit" => {
                            app.exit(0);
                        }
                        _ => {}
                    }
                })
                .on_tray_icon_event(|tray, event| {
                    // Double-click or left-click on tray icon → show window
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        ..
                    } = event
                    {
                        let app = tray.app_handle();
                        if let Some(window) = app.get_webview_window("main") {
                            let _ = window.show();
                            let _ = window.unminimize();
                            let _ = window.set_focus();
                        }
                    }
                })
                .build(app)
                .is_ok();

            if !has_tray {
                eprintln!("[Voxium] System tray unavailable — close will quit the app instead of minimizing to tray");
            }

            // Set window icon and close behavior
            if let Some(window) = app.get_webview_window("main") {
                let icon = tauri::include_image!("icons/icon.png");
                let _ = window.set_icon(icon.clone());

                // If tray is available: close → hide to tray
                // If no tray (Linux GNOME/Wayland): close → quit the app
                let win = window.clone();
                let app_handle = app.handle().clone();
                window.on_window_event(move |event| {
                    if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                        if has_tray {
                            api.prevent_close();
                            let _ = win.hide();
                        } else {
                            app_handle.exit(0);
                        }
                    }
                });
            }

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
