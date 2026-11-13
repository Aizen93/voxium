use std::io::Read;

#[cfg(windows)]
mod share_bar;

// Ctrl-C in the dev console exits with 0 (debug builds on Windows only)
#[cfg(all(windows, debug_assertions))]
mod dev_console;

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
    !name.is_empty()
        && name
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
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
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '.' || c == '-' || c == '_' {
                c
            } else {
                '_'
            }
        })
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
    // The 10 s budget covers the whole exchange, the 302 to the object store
    // included (ureq follows it; a non-2xx final answer is an Err).
    let response = ureq::get(&url)
        .config()
        .timeout_global(Some(std::time::Duration::from_secs(10)))
        .build()
        .call()
        .map_err(|_| "Avatar download failed".to_string())?;

    let mut bytes = Vec::new();
    response
        .into_body()
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
        || bytes.starts_with(b"GIF8") // GIF
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
        Ok(())
    }

    #[cfg(not(target_os = "windows"))]
    {
        let _ = (app, title, body, api_base, avatar_key);
        Err("Avatar notifications not implemented on this platform".to_string())
    }
}

// ─── Which credential-store services a build uses ────────────────────────────
// The OS credential store is one per OS user, shared by every application:
// the service name is what keeps one build's entries apart from another's.
// Both services derive from the identifier the build was compiled with
// (tauri.conf.json's `com.voxium.app` for the official app, a derived one for
// a build made for another server: scripts/tauriSelfHosted.mjs), read from
// the compiled configuration on this side of the IPC boundary. The webview
// names an entry, never the service it lives in, so the set of entries a
// build can reach stays closed, and builds for different servers keep
// separate secrets.

/// The identifier of the official release (tauri.conf.json).
const OFFICIAL_IDENTIFIER: &str = "com.voxium.app";

/// The credential-store services one build keeps its secrets under.
#[derive(Debug, Clone, PartialEq, Eq)]
struct KeychainServices {
    /// The session entries (`SESSION_SECRET_NAMES`).
    session: String,
    /// The E2E pickle keys, one entry per user id.
    e2e_pickle_key: String,
}

/// The services of the build whose identifier is `identifier`. The only place
/// their names are built.
fn keychain_services(identifier: &str) -> KeychainServices {
    if identifier == OFFICIAL_IDENTIFIER {
        // The names every installed official app already keeps its session
        // and its vault key under, byte for byte (a test pins them): one
        // character off and the update signs every user out and loses the key
        // to their vault
        return KeychainServices {
            session: "app.voxium.session".to_owned(),
            e2e_pickle_key: "app.voxium.e2e-pickle-key".to_owned(),
        };
    }
    KeychainServices {
        session: format!("{identifier}.session"),
        e2e_pickle_key: format!("{identifier}.e2e-pickle-key"),
    }
}

/// The services of the running build, from its compiled configuration.
fn build_keychain_services(app: &tauri::AppHandle) -> KeychainServices {
    keychain_services(&app.config().identifier)
}

// ─── E2E pickle key in the OS keychain (docs/e2e-dm-spec.md §7.3) ────────────
// The 32-byte vodozemac pickle key is the one secret the webview handles.
// These commands move it from localStorage into the platform credential store
// (Windows Credential Manager / macOS Keychain / Linux Secret Service), under
// the build's own service (`keychain_services`), so webview code can only
// ever touch its own build's E2E entries.

fn valid_e2e_user_id(user_id: &str) -> bool {
    !user_id.is_empty()
        && user_id.len() <= 64
        && user_id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

fn pickle_key_entry(service: &str, user_id: &str) -> Result<keyring::Entry, String> {
    keyring::Entry::new(service, user_id).map_err(|e| e.to_string())
}

fn read_pickle_key(service: &str, user_id: &str) -> Result<Option<String>, String> {
    if !valid_e2e_user_id(user_id) {
        return Err("invalid user id".to_string());
    }
    match pickle_key_entry(service, user_id)?.get_password() {
        Ok(value) => Ok(Some(value)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(e.to_string()),
    }
}

fn write_pickle_key(service: &str, user_id: &str, key_b64: &str) -> Result<(), String> {
    if !valid_e2e_user_id(user_id) {
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
    pickle_key_entry(service, user_id)?
        .set_password(key_b64)
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn e2e_pickle_key_get(app: tauri::AppHandle, user_id: String) -> Result<Option<String>, String> {
    read_pickle_key(&build_keychain_services(&app).e2e_pickle_key, &user_id)
}

#[tauri::command]
fn e2e_pickle_key_set(
    app: tauri::AppHandle,
    user_id: String,
    key_b64: String,
) -> Result<(), String> {
    write_pickle_key(
        &build_keychain_services(&app).e2e_pickle_key,
        &user_id,
        &key_b64,
    )
}

// ─── Session credentials in the OS keychain ──────────────────────────────────
// The signed-in session ("Remember me": the access + refresh token pair) and
// the trusted-device token (skips TOTP for 30 days) are bearer credentials.
// They used to sit in the webview's localStorage — a plaintext LevelDB under
// the user's profile, copied into every backup and readable by anything that
// can read the user's files — and now live in the platform credential store,
// like the pickle key above: encrypted at rest under the OS user's login
// (macOS also gates access per application; Windows and the Secret Service
// grant it to the user's processes). The same shape as the pickle key: the
// build's own service (`keychain_services`) and a closed set of entry names
// on the Rust side of the IPC boundary, so webview code can only ever reach
// its own build's entries, and a value is shape-checked before it is
// written. The webview side is services/tokenStorage.ts
// (`createKeychainSessionStore`). Builds with the same identifier (the
// official app and `tauri dev`) share these entries, so the webview also
// stamps each value with the origin of the API that issued it and never uses
// a value stamped with another one.

const SESSION_SECRET_NAMES: &[&str] = &["tokens", "trusted-device"];
/// Windows caps a generic credential's blob at 2560 bytes and the keyring
/// crate stores a password as UTF-16: 1280 code units. Two JWTs in the JSON
/// pair the webview writes are ~600 ASCII characters; anything past this cap
/// is a bug, not a credential.
const SESSION_SECRET_MAX_CHARS: usize = 1280;

fn session_entry(service: &str, name: &str) -> Result<keyring::Entry, String> {
    if !SESSION_SECRET_NAMES.contains(&name) {
        return Err("unknown credential".to_string());
    }
    keyring::Entry::new(service, name).map_err(|e| e.to_string())
}

/// Printable ASCII without spaces, bounded: a JWT (base64url and dots) or the
/// JSON pair the webview wraps two of them in. Nothing else is ours to store.
fn valid_session_secret_value(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= SESSION_SECRET_MAX_CHARS
        && value.bytes().all(|b| (0x21..=0x7e).contains(&b))
}

/// The stored value, `None` when there is no such entry.
fn read_session_secret(service: &str, name: &str) -> Result<Option<String>, String> {
    match session_entry(service, name)?.get_password() {
        Ok(value) => Ok(Some(value)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(e.to_string()),
    }
}

fn write_session_secret(service: &str, name: &str, value: &str) -> Result<(), String> {
    if !valid_session_secret_value(value) {
        return Err("invalid credential format".to_string());
    }
    session_entry(service, name)?
        .set_password(value)
        .map_err(|e| e.to_string())
}

/// Removing an entry that is not there is the state the caller asked for.
fn delete_session_secret(service: &str, name: &str) -> Result<(), String> {
    match session_entry(service, name)?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(e.to_string()),
    }
}

// The keyring calls block (Credential Manager, the Keychain, a D-Bus round
// trip to the Secret Service): they run on the blocking pool, off the thread
// that paints the window.

#[tauri::command]
async fn session_secret_get(app: tauri::AppHandle, name: String) -> Result<Option<String>, String> {
    let service = build_keychain_services(&app).session;
    tauri::async_runtime::spawn_blocking(move || read_session_secret(&service, &name))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn session_secret_set(
    app: tauri::AppHandle,
    name: String,
    value: String,
) -> Result<(), String> {
    let service = build_keychain_services(&app).session;
    tauri::async_runtime::spawn_blocking(move || write_session_secret(&service, &name, &value))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn session_secret_delete(app: tauri::AppHandle, name: String) -> Result<(), String> {
    let service = build_keychain_services(&app).session;
    tauri::async_runtime::spawn_blocking(move || delete_session_secret(&service, &name))
        .await
        .map_err(|e| e.to_string())?
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

            // `pnpm dev`'s Ctrl-C reaches this console process too: exit 0
            // instead of STATUS_CONTROL_C_EXIT, which cargo and the Tauri CLI
            // report as an error (dev_console.rs)
            #[cfg(all(windows, debug_assertions))]
            dev_console::exit_cleanly_on_ctrl_c();

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

                // WebView2 names the page origin on its screen-share bar; the
                // bar is hidden once a capture starts (share_bar.rs, Windows only)
                #[cfg(windows)]
                share_bar::hide_on_capture(&window, share_bar::app_host(app.config()));

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

#[cfg(test)]
mod session_secret_tests {
    use super::*;

    /// Every test in this binary shares the process-wide default builder:
    /// the in-memory mock store, never the machine's own credential store.
    fn use_mock_store() {
        static ONCE: std::sync::Once = std::sync::Once::new();
        ONCE.call_once(|| {
            keyring::set_default_credential_builder(keyring::mock::default_credential_builder())
        });
    }

    /// The session service of the official app.
    fn svc() -> String {
        keychain_services(OFFICIAL_IDENTIFIER).session
    }

    #[test]
    fn only_the_known_entry_names_resolve() {
        use_mock_store();
        assert!(session_entry(&svc(), "tokens").is_ok());
        assert!(session_entry(&svc(), "trusted-device").is_ok());
        for name in [
            "",
            "token",
            "Tokens",
            "../tokens",
            "e2e-pickle-key",
            "alice",
        ] {
            assert_eq!(
                session_entry(&svc(), name).unwrap_err(),
                "unknown credential",
                "{name:?}"
            );
            assert_eq!(
                read_session_secret(&svc(), name).unwrap_err(),
                "unknown credential"
            );
            assert_eq!(
                write_session_secret(&svc(), name, "abc").unwrap_err(),
                "unknown credential"
            );
            assert_eq!(
                delete_session_secret(&svc(), name).unwrap_err(),
                "unknown credential"
            );
        }
    }

    #[test]
    fn a_missing_entry_reads_as_none_and_deletes_as_ok() {
        use_mock_store();
        // the two entries are independent: this one is never written here
        assert_eq!(read_session_secret(&svc(), "trusted-device"), Ok(None));
        assert_eq!(delete_session_secret(&svc(), "trusted-device"), Ok(()));
        assert_eq!(read_session_secret(&svc(), "trusted-device"), Ok(None));
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
        assert_eq!(write_session_secret(&svc(), "tokens", pair), Ok(()));
        assert_eq!(
            write_session_secret(&svc(), "trusted-device", "eyJhbGciOiJIUzI1NiJ9.a.b"),
            Ok(())
        );
        // a second delete is still the state the caller asked for
        assert_eq!(delete_session_secret(&svc(), "tokens"), Ok(()));
        assert_eq!(delete_session_secret(&svc(), "tokens"), Ok(()));
    }

    /// The entries carry the origin of the API that issued them
    /// (services/tokenStorage.ts): the pair with its origin as one JSON
    /// object, the trusted-device token as `{ token, origin }`. Both stay
    /// printable ASCII without spaces, and a long pair with a long origin
    /// still fits the Windows cap.
    #[test]
    fn the_stamped_entries_the_webview_writes_are_accepted() {
        use_mock_store();
        let jwt = format!("eyJhbGciOiJIUzI1NiJ9.{}.sig", "a".repeat(380));
        let host = format!("{}.example.org", "h".repeat(240));
        let pair = format!(
            "{{\"accessToken\":\"{jwt}\",\"refreshToken\":\"{jwt}\",\"origin\":\"https://{host}:8443\"}}"
        );
        assert!(
            pair.len() <= SESSION_SECRET_MAX_CHARS,
            "{} chars",
            pair.len()
        );
        assert!(valid_session_secret_value(&pair));
        assert_eq!(write_session_secret(&svc(), "tokens", &pair), Ok(()));

        let trusted = format!("{{\"token\":\"{jwt}\",\"origin\":\"https://chat.example.org\"}}");
        assert!(valid_session_secret_value(&trusted));
        assert_eq!(
            write_session_secret(&svc(), "trusted-device", &trusted),
            Ok(())
        );
        // an older build's bare trusted-device token is still a valid value
        assert!(valid_session_secret_value(&jwt));
    }

    #[test]
    fn a_malformed_value_is_refused_before_the_store_is_touched() {
        use_mock_store();
        for bad in [
            "",
            "with space",
            "héllo",
            &"a".repeat(SESSION_SECRET_MAX_CHARS + 1),
        ] {
            assert_eq!(
                write_session_secret(&svc(), "tokens", bad).unwrap_err(),
                "invalid credential format"
            );
        }
        assert_eq!(read_session_secret(&svc(), "tokens"), Ok(None));
    }

    #[test]
    fn a_value_is_bounded_printable_ascii_without_spaces() {
        let jwt = "eyJhbGciOiJIUzI1NiJ9.eyJ1c2VySWQiOiJjbHgxIn0.abc-_DEF";
        assert!(valid_session_secret_value(jwt));
        assert!(valid_session_secret_value(&format!(
            "{{\"accessToken\":\"{jwt}\",\"refreshToken\":\"{jwt}\"}}"
        )));
        assert!(valid_session_secret_value(
            &"a".repeat(SESSION_SECRET_MAX_CHARS)
        ));

        assert!(!valid_session_secret_value(""));
        assert!(!valid_session_secret_value(
            &"a".repeat(SESSION_SECRET_MAX_CHARS + 1)
        ));
        assert!(!valid_session_secret_value("with space"));
        assert!(!valid_session_secret_value("line\nbreak"));
        assert!(!valid_session_secret_value("nul\0byte"));
        assert!(!valid_session_secret_value("héllo"));
        assert!(!valid_session_secret_value("\u{7f}"));
    }

    /// The pickle-key helpers keep the commands' checks, in the same order,
    /// whatever service the build reads them under.
    #[test]
    fn a_pickle_key_is_shape_checked_before_the_store_is_touched() {
        use_mock_store();
        let key = "A".repeat(43);
        for identifier in [
            OFFICIAL_IDENTIFIER,
            "com.voxium.selfhosted.s0123456789abcdef",
        ] {
            let service = keychain_services(identifier).e2e_pickle_key;
            for bad_user in ["", "a.b", "../x", &"u".repeat(65)] {
                assert_eq!(
                    read_pickle_key(&service, bad_user).unwrap_err(),
                    "invalid user id"
                );
                assert_eq!(
                    write_pickle_key(&service, bad_user, &key).unwrap_err(),
                    "invalid user id"
                );
            }
            for bad_key in [
                "",
                "short",
                &"A".repeat(45),
                &format!("{}!", "A".repeat(42)),
            ] {
                assert_eq!(
                    write_pickle_key(&service, "user_1", bad_key).unwrap_err(),
                    "invalid key format"
                );
            }
            assert_eq!(read_pickle_key(&service, "user_1"), Ok(None));
            assert_eq!(write_pickle_key(&service, "user_1", &key), Ok(()));
        }
    }
}

/// The credential-store services every keychain command reads its entries
/// under (`keychain_services`): the official app's names never move, and a
/// build with another identifier never reaches them.
#[cfg(test)]
mod keychain_services_tests {
    use super::*;

    /// What `scripts/tauriSelfHosted.mjs` writes for a build for another server.
    const SELF_HOSTED: &str = "com.voxium.selfhosted.s0123456789abcdef";

    /// Byte for byte the services every installed official app (2.1.1 and
    /// every release before it) holds its session and its vault key under:
    /// an update that read anything else would sign every user out and lose
    /// the key to their vault.
    #[test]
    fn the_official_identifier_keeps_the_names_every_install_uses() {
        let services = keychain_services("com.voxium.app");
        assert_eq!(services.session.as_bytes(), b"app.voxium.session");
        assert_eq!(
            services.e2e_pickle_key.as_bytes(),
            b"app.voxium.e2e-pickle-key"
        );
    }

    #[test]
    fn the_official_identifier_is_the_one_tauri_conf_json_compiles_in() {
        let conf: serde_json::Value = serde_json::from_str(include_str!("../tauri.conf.json"))
            .expect("tauri.conf.json is JSON");
        assert_eq!(conf["identifier"], OFFICIAL_IDENTIFIER);
    }

    #[test]
    fn another_identifier_has_names_of_its_own() {
        let official = keychain_services(OFFICIAL_IDENTIFIER);
        let official_names = [official.session.as_str(), official.e2e_pickle_key.as_str()];
        for identifier in [
            SELF_HOSTED,
            "com.voxium.selfhosted.sfedcba9876543210",
            "com.voxium.app.dev",
            "com.voxium",
            "com.example.chat",
        ] {
            let services = keychain_services(identifier);
            assert!(
                !official_names.contains(&services.session.as_str()),
                "{identifier}"
            );
            assert!(
                !official_names.contains(&services.e2e_pickle_key.as_str()),
                "{identifier}"
            );
            assert_ne!(services.session, services.e2e_pickle_key, "{identifier}");
            assert_eq!(services.session, format!("{identifier}.session"));
            assert_eq!(
                services.e2e_pickle_key,
                format!("{identifier}.e2e-pickle-key")
            );
        }
    }

    #[test]
    fn two_servers_get_two_sets_of_names() {
        let a = keychain_services(SELF_HOSTED);
        let b = keychain_services("com.voxium.selfhosted.sfedcba9876543210");
        assert_ne!(a.session, b.session);
        assert_ne!(a.e2e_pickle_key, b.e2e_pickle_key);
        assert_eq!(a, keychain_services(SELF_HOSTED));
    }

    /// The names are built in `keychain_services` alone, and the store is
    /// opened only through the two helpers, with the service their caller
    /// passes; every caller takes it from the compiled configuration, and no
    /// command takes a service or an identifier from the webview.
    #[test]
    fn the_service_names_are_built_in_one_place() {
        let source = include_str!("lib.rs");
        let code = &source[..source
            .find("\n#[cfg(test)]")
            .expect("the tests follow the code")];

        let start = code
            .find("fn keychain_services(")
            .expect("keychain_services");
        let end = start + code[start..].find("\n}\n").expect("its end");
        for literal in ["\"app.voxium.session\"", "\"app.voxium.e2e-pickle-key\""] {
            assert_eq!(code.matches(literal).count(), 1, "{literal}");
            let at = code.find(literal).expect("present");
            assert!(
                at > start && at < end,
                "{literal} outside keychain_services"
            );
        }
        for retired in ["SESSION_KEYCHAIN_SERVICE", "E2E_KEYCHAIN_SERVICE"] {
            assert!(!code.contains(retired), "{retired}");
        }

        let opened: Vec<&str> = code
            .match_indices("keyring::Entry::new(")
            .map(|(at, m)| &code[at + m.len()..])
            .collect();
        assert_eq!(opened.len(), 2, "the store is opened by two helpers");
        assert!(opened.iter().all(|rest| rest.starts_with("service, ")));
        assert_eq!(
            code.matches("keychain_services(&app.config().identifier)")
                .count(),
            1
        );
        assert_eq!(code.matches("build_keychain_services(&app)").count(), 5);
        assert!(!code.contains("service: String"));
        assert!(!code.contains("identifier: String"));
    }
}

/// The updater plugin is registered in every build and deserialises
/// `plugins > updater` when the app starts: a block it cannot read is an app
/// that does not open. A self-hosted build without a feed ships the emptied
/// block `scripts/tauriSelfHosted.mjs` writes (its test pins the same JSON).
#[cfg(test)]
mod updater_config_tests {
    use tauri_plugin_updater::Config;

    #[test]
    fn a_build_without_a_feed_starts_with_the_emptied_block() {
        let none: Config =
            serde_json::from_value(serde_json::json!({ "endpoints": [], "pubkey": "" }))
                .expect("the no-updater block must deserialise");
        assert!(none.endpoints.is_empty());
        assert!(none.pubkey.is_empty());
    }

    #[test]
    fn a_removed_block_or_one_without_a_key_would_stop_the_app() {
        assert!(serde_json::from_value::<Config>(serde_json::Value::Null).is_err());
        assert!(serde_json::from_value::<Config>(serde_json::json!({ "endpoints": [] })).is_err());
    }

    #[test]
    fn the_official_block_in_tauri_conf_json_deserialises_with_its_feed() {
        let conf: serde_json::Value = serde_json::from_str(include_str!("../tauri.conf.json"))
            .expect("tauri.conf.json is JSON");
        let official: Config = serde_json::from_value(conf["plugins"]["updater"].clone())
            .expect("the release updater block must deserialise");
        assert!(!official.endpoints.is_empty());
        assert!(official.endpoints.iter().all(|url| url.scheme() == "https"));
        assert!(!official.pubkey.is_empty());
    }
}
