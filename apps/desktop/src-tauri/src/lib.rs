use std::io::Read;
use tauri::Manager;

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

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .invoke_handler(tauri::generate_handler![notify_with_avatar])
        .setup(|app| {
            if let Some(window) = app.get_webview_window("main") {
                let icon = tauri::include_image!("icons/icon.png");
                let _ = window.set_icon(icon);
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
