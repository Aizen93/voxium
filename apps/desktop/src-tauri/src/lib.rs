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

// ─── Where the native avatar download may go ─────────────────────────────────
// On Windows a notification's avatar is downloaded here, in native code, which
// the webview's Content Security Policy does not bind. The webview names the
// API base it was built with (`notify_with_avatar`'s `api_base`); that value is
// compared, never trusted: it is accepted only when its origin (scheme, host,
// port) is an http(s) origin the `connect-src` of the policy this app was
// BUILT with names exactly, read from the compiled configuration. The official
// release and a build for another server both carry the origins they may
// contact in that policy (scripts/tauriCsp.mjs, scripts/tauriSelfHosted.mjs),
// so the native download can reach nothing the webview could not already
// reach. A wildcard source (`https://*.example.com`) matches nothing here, nor
// does Tauri's own channel (`http://ipc.localhost`). A debug build also takes
// `http://localhost` and `http://127.0.0.1` on any port: `tauri dev` runs the
// official policy against a local server. The request is built from the
// checked base, asks the server to proxy the image (`?inline`) and follows no
// redirect, so it never leaves that origin.

/// Tauri's IPC channel on Windows and Android: named in every build's
/// `connect-src` (`TAURI_IPC_SOURCES`, scripts/tauriCsp.mjs), and no server.
const TAURI_IPC_HOST: &str = "ipc.localhost";

/// An http(s) origin: scheme, lower-case host and port (the scheme's default
/// when the URL names none, so `https://h` and `https://h:443` are one).
#[derive(Debug, Clone, PartialEq, Eq)]
struct HttpOrigin {
    scheme: String,
    host: String,
    port: u16,
}

fn http_origin(url: &tauri::Url) -> Option<HttpOrigin> {
    if url.scheme() != "http" && url.scheme() != "https" {
        return None;
    }
    // A domain (lower-cased by the parser) or an IPv4 address; a CSP source
    // cannot name an IPv6 literal (`[…]`)
    let host = url.host_str().filter(|host| !host.starts_with('['))?;
    Some(HttpOrigin {
        scheme: url.scheme().to_owned(),
        host: host.to_ascii_lowercase(),
        port: url.port_or_known_default()?,
    })
}

/// The origin a `connect-src` source names exactly, `None` for every other
/// kind of source: a keyword (`'self'`), a scheme source (`ipc:`, `blob:`), a
/// ws(s) source, a wildcard host or port, a source with a path (it allows that
/// path only), credentials, Tauri's IPC host.
fn exact_source_origin(source: &str) -> Option<HttpOrigin> {
    let lower = source.to_ascii_lowercase();
    if !lower.starts_with("http://") && !lower.starts_with("https://") {
        return None;
    }
    // The URL parser takes `*` as a host character: refuse it before parsing
    if source.contains('*') || source.contains('@') {
        return None;
    }
    let url = tauri::Url::parse(source).ok()?;
    if url.path() != "/" || url.query().is_some() || url.fragment().is_some() {
        return None;
    }
    let origin = http_origin(&url)?;
    (origin.host != TAURI_IPC_HOST).then_some(origin)
}

/// The `connect-src` sources of a policy written as one string: the first
/// such directive, as a browser reads it (the name in any case).
fn connect_src_of_policy(policy: &str) -> Vec<String> {
    policy
        .split(';')
        .find_map(|directive| {
            let mut tokens = directive.split_ascii_whitespace();
            let name = tokens.next()?;
            name.eq_ignore_ascii_case("connect-src")
                .then(|| tokens.map(str::to_owned).collect())
        })
        .unwrap_or_default()
}

/// The `connect-src` sources of the policy the app was built with, written as
/// a string or as a map of directives; none without a policy.
fn connect_src_of(csp: Option<&tauri::utils::config::Csp>) -> Vec<String> {
    use tauri::utils::config::Csp;
    match csp {
        None => Vec::new(),
        Some(Csp::Policy(policy)) => connect_src_of_policy(policy),
        Some(Csp::DirectiveMap(directives)) => directives
            .get("connect-src")
            .map(|sources| {
                let sources: Vec<String> = sources.clone().into();
                sources
                    .iter()
                    .flat_map(|source| source.split_ascii_whitespace())
                    .map(str::to_owned)
                    .collect()
            })
            .unwrap_or_default(),
    }
}

/// The parsed `base` when its origin is one `connect_src` names exactly (or,
/// with `allow_dev_loopback`, http on localhost or 127.0.0.1); refused
/// otherwise, and refused whenever it carries credentials, a query or a
/// fragment.
fn allowed_avatar_base(
    connect_src: &[String],
    base: &str,
    allow_dev_loopback: bool,
) -> Result<tauri::Url, String> {
    const REFUSED: &str = "The API base is not an origin this app's content security policy allows";
    let url = tauri::Url::parse(base).map_err(|_| REFUSED.to_string())?;
    if !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err(REFUSED.to_string());
    }
    let origin = http_origin(&url).ok_or_else(|| REFUSED.to_string())?;
    let named = connect_src
        .iter()
        .filter_map(|source| exact_source_origin(source))
        .any(|allowed| allowed == origin);
    let dev_loopback = allow_dev_loopback
        && origin.scheme == "http"
        && (origin.host == "localhost" || origin.host == "127.0.0.1");
    if named || dev_loopback {
        Ok(url)
    } else {
        Err(REFUSED.to_string())
    }
}

/// `{base}/uploads/{key}?inline`, built on the checked base: the server
/// proxies the image instead of redirecting to the object store.
fn avatar_url(base: &tauri::Url, key: &str) -> Result<tauri::Url, String> {
    let mut url = base.clone();
    url.path_segments_mut()
        .map_err(|_| "Invalid API base URL".to_string())?
        .pop_if_empty()
        .push("uploads")
        .extend(key.split('/'));
    url.set_query(Some("inline"));
    Ok(url)
}

/// GET the image at `url`, following no redirect (a redirect answer is a
/// failure, like any other answer that is not a success), at most 1 MB, and
/// only an image.
fn download_avatar(url: &tauri::Url) -> Result<Vec<u8>, String> {
    // The 10 s budget covers the whole exchange
    let response = ureq::get(url.as_str())
        .config()
        .timeout_global(Some(std::time::Duration::from_secs(10)))
        .max_redirects(0)
        .build()
        .call()
        .map_err(|_| "Avatar download failed".to_string())?;
    if !response.status().is_success() {
        return Err("Avatar download failed".to_string());
    }

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
    Ok(bytes)
}

/// Download an avatar image to the temp directory and return the file path.
/// `api_base` is a base `allowed_avatar_base` returned. Validates the key
/// against the strict S3 key regex, then the image (`download_avatar`).
fn cache_avatar_to_file(api_base: &tauri::Url, key: &str) -> Result<std::path::PathBuf, String> {
    if !is_valid_avatar_key(key) {
        return Err("Invalid avatar key".to_string());
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

    let bytes = download_avatar(&avatar_url(api_base, key)?)?;

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
/// An API base the build's policy does not allow is refused before anything
/// is fetched or shown (`allowed_avatar_base`); an avatar that cannot be
/// downloaded leaves the toast without one.
/// On other platforms: returns Err so the JS side falls through to the Tauri plugin / Web API.
///
/// The download, the file cache and the toast block (a network round trip of
/// up to 10 s, disk work, a WinRT call): they run on the blocking pool, off
/// the thread that paints the window. The toast has no thread of its own to
/// keep: tauri-winrt-notification makes plain WinRT calls with no apartment
/// set up, which windows-core runs in the process's multithreaded apartment
/// on any thread, and Tauri's notification plugin shows its toasts from a
/// runtime task too. Only the compiled configuration is read here.
#[tauri::command]
async fn notify_with_avatar(
    app: tauri::AppHandle,
    title: String,
    body: String,
    api_base: Option<String>,
    avatar_key: Option<String>,
) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        let app_id = get_windows_app_id(&app);
        let connect_src = connect_src_of(app.config().app.security.csp.as_ref());
        tauri::async_runtime::spawn_blocking(move || {
            show_avatar_toast(
                &app_id,
                &title,
                &body,
                &connect_src,
                api_base.as_deref(),
                avatar_key.as_deref(),
            )
        })
        .await
        .map_err(|e| e.to_string())?
    }

    #[cfg(not(target_os = "windows"))]
    {
        let _ = (app, title, body, api_base, avatar_key);
        Err("Avatar notifications not implemented on this platform".to_string())
    }
}

/// The toast `notify_with_avatar` shows, on the blocking pool: the base
/// checked against the build's `connect-src` before anything else.
#[cfg(target_os = "windows")]
fn show_avatar_toast(
    app_id: &str,
    title: &str,
    body: &str,
    connect_src: &[String],
    api_base: Option<&str>,
    avatar_key: Option<&str>,
) -> Result<(), String> {
    use tauri_winrt_notification::{IconCrop, Toast};

    let mut toast = Toast::new(app_id).title(title).text2(body);

    if let (Some(base), Some(key)) = (api_base, avatar_key) {
        let base = allowed_avatar_base(connect_src, base, cfg!(debug_assertions))?;
        match cache_avatar_to_file(&base, key) {
            Ok(path) => toast = toast.icon(&path, IconCrop::Circular, ""),
            Err(e) => eprintln!("[Voxium] Notification avatar: {e}"),
        }
    }

    toast.show().map_err(|e| format!("{e:?}"))?;
    Ok(())
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

/// Removing a key that is not there is the state the caller asked for.
fn remove_pickle_key_entry(entry: &keyring::Entry) -> Result<(), String> {
    match entry.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(e.to_string()),
    }
}

/// The key of an account deleted on this device, removed with its vault
/// (`forgetLocalE2EState` on the webview side). A logout never calls it: the
/// vault outlives a logout, and so does the key that opens it.
fn delete_pickle_key(service: &str, user_id: &str) -> Result<(), String> {
    if !valid_e2e_user_id(user_id) {
        return Err("invalid user id".to_string());
    }
    remove_pickle_key_entry(&pickle_key_entry(service, user_id)?)
}

// The keyring calls block (Credential Manager, the Keychain, a D-Bus round
// trip to the Secret Service): on the blocking pool, off the thread that
// paints the window, like the session commands below.

#[tauri::command]
async fn e2e_pickle_key_get(
    app: tauri::AppHandle,
    user_id: String,
) -> Result<Option<String>, String> {
    let service = build_keychain_services(&app).e2e_pickle_key;
    tauri::async_runtime::spawn_blocking(move || read_pickle_key(&service, &user_id))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn e2e_pickle_key_delete(app: tauri::AppHandle, user_id: String) -> Result<(), String> {
    let service = build_keychain_services(&app).e2e_pickle_key;
    tauri::async_runtime::spawn_blocking(move || delete_pickle_key(&service, &user_id))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn e2e_pickle_key_set(
    app: tauri::AppHandle,
    user_id: String,
    key_b64: String,
) -> Result<(), String> {
    let service = build_keychain_services(&app).e2e_pickle_key;
    tauri::async_runtime::spawn_blocking(move || write_pickle_key(&service, &user_id, &key_b64))
        .await
        .map_err(|e| e.to_string())?
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

/// Bring the running app to the front: the main window shown, restored and
/// focused. While the app is still starting, the splash window is on screen
/// and the main one not ready, so the splash is focused instead. The tray
/// uses it, and so does a second launch of the app.
fn show_main_window(app: &tauri::AppHandle) {
    use tauri::Manager;

    if let Some(splash) = app.get_webview_window("splash") {
        let _ = splash.set_focus();
        return;
    }
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}

pub fn run() {
    let builder = tauri::Builder::default();

    // One running app per build. Closing the window hides the app in the tray,
    // so opening it again from its shortcut must bring that app back, not
    // start a second one beside it (two processes on one vault and one
    // session store). The plugin hands a second launch over to the running
    // app and must be the first one registered. Builds are told apart by their
    // identifier, so a build for another server runs beside the official app.
    // Not in debug builds: `tauri dev` has the official identifier, and would
    // hand over to an installed app instead of starting. `cfg!`, not an
    // attribute, so that a debug build still compiles the registration.
    let builder = if cfg!(debug_assertions) {
        builder
    } else {
        builder.plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            show_main_window(app);
        }))
    };

    builder
        // External links, opened by the webview's own click handler
        // (apps/desktop/src/utils/externalLinks.ts): the plugin's injected one stays off,
        // so one place decides which links leave the app
        .plugin(
            tauri_plugin_opener::Builder::new()
                .open_js_links_on_click(false)
                .build(),
        )
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .invoke_handler(tauri::generate_handler![
            notify_with_avatar,
            e2e_pickle_key_get,
            e2e_pickle_key_set,
            e2e_pickle_key_delete,
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
                        "show" => show_main_window(app),
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
                        show_main_window(tray.app_handle());
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

    /// The delete takes the user id the read and the write take, checked the
    /// same way, and a key that is not there is already deleted.
    #[test]
    fn a_pickle_key_delete_checks_the_id_and_takes_a_missing_key_as_done() {
        use_mock_store();
        for identifier in [
            OFFICIAL_IDENTIFIER,
            "com.voxium.selfhosted.s0123456789abcdef",
        ] {
            let service = keychain_services(identifier).e2e_pickle_key;
            for bad_user in ["", "a.b", "../x", "a b", "user\0", &"u".repeat(65)] {
                assert_eq!(
                    delete_pickle_key(&service, bad_user).unwrap_err(),
                    "invalid user id",
                    "{bad_user:?}"
                );
            }
            assert_eq!(delete_pickle_key(&service, "user_1"), Ok(()));
            assert_eq!(delete_pickle_key(&service, "user_1"), Ok(()));
            assert_eq!(delete_pickle_key(&service, &"u".repeat(64)), Ok(()));
        }
    }

    /// The mock store keeps one credential per `Entry`, so these entries are
    /// held here and handed to the removal: the one removed is gone, the other
    /// account's key is still there. Which entry the command opens for a user
    /// id is `pickle_key_entry`, the same call the read and the write make.
    #[test]
    fn a_pickle_key_delete_removes_that_entry_and_no_other() {
        use_mock_store();
        let service = keychain_services(OFFICIAL_IDENTIFIER).e2e_pickle_key;
        let key = "A".repeat(43);
        let deleted = pickle_key_entry(&service, "user_a").expect("entry");
        let kept = pickle_key_entry(&service, "user_b").expect("entry");
        deleted.set_password(&key).expect("stored");
        kept.set_password(&key).expect("stored");

        assert_eq!(remove_pickle_key_entry(&deleted), Ok(()));
        assert!(matches!(
            deleted.get_password(),
            Err(keyring::Error::NoEntry)
        ));
        assert_eq!(kept.get_password().expect("still stored"), key);
        // removing it again is still the state asked for
        assert_eq!(remove_pickle_key_entry(&deleted), Ok(()));
    }

    #[test]
    fn a_store_that_refuses_the_delete_is_reported() {
        use_mock_store();
        let service = keychain_services(OFFICIAL_IDENTIFIER).e2e_pickle_key;
        let entry = pickle_key_entry(&service, "user_c").expect("entry");
        entry.set_password(&"A".repeat(43)).expect("stored");
        let mock: &keyring::mock::MockCredential = entry
            .get_credential()
            .downcast_ref()
            .expect("the mock store");
        mock.set_error(keyring::Error::NoStorageAccess("locked".into()));

        assert!(remove_pickle_key_entry(&entry).is_err());
        // the refusal removed nothing
        assert!(entry.get_password().is_ok());
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
        assert_eq!(code.matches("build_keychain_services(&app)").count(), 6);
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

/// One running app per build. The single-instance plugin is registered first
/// (plugins run in the order they are added), in release builds only (a debug
/// build has the official identifier and would hand over to an installed
/// app) but compiled in every build, and a second launch brings the running
/// app to the front.
#[cfg(test)]
mod single_instance_tests {
    #[test]
    fn a_second_launch_hands_over_to_the_running_app() {
        let source = include_str!("lib.rs");
        let code = &source[..source
            .find("\n#[cfg(test)]")
            .expect("the tests follow the code")];
        let run = &code[code.find("pub fn run() {").expect("run")..];

        let single = run
            .find("tauri_plugin_single_instance::init(")
            .expect("the plugin is registered");
        let others = run
            .find("tauri_plugin_opener::Builder::new()")
            .expect("the other plugins");
        assert!(single < others, "registered before every other plugin");
        assert_eq!(run.matches(".plugin(").count(), 5, "one more than before");

        // release builds only, by a condition every build compiles
        let gate = run[..single]
            .rfind("if cfg!(debug_assertions) {")
            .expect("release builds only");
        let between: Vec<&str> = run[gate..single].lines().map(str::trim).collect();
        assert_eq!(
            between,
            [
                "if cfg!(debug_assertions) {",
                "builder",
                "} else {",
                "builder.plugin("
            ],
            "a debug build registers nothing, a release build the plugin"
        );
        assert!(!run.contains("#[cfg(not(debug_assertions))]"));

        let callback = &run[single..others];
        assert!(callback.contains("show_main_window(app)"));
    }

    #[test]
    fn the_running_app_comes_back_through_one_function() {
        let source = include_str!("lib.rs");
        let code = &source[..source
            .find("\n#[cfg(test)]")
            .expect("the tests follow the code")];

        // the tray's menu entry, a click on its icon and a second launch
        assert_eq!(code.matches("show_main_window(").count(), 4);
        // nothing else shows the main window by hand
        assert_eq!(code.matches("window.show()").count(), 1);
        let start = code.find("fn show_main_window(").expect("show_main_window");
        let end = start + code[start..].find("\n}\n").expect("its end");
        let body = &code[start..end];
        let splash = body.find("get_webview_window(\"splash\")").expect("splash");
        let main = body.find("get_webview_window(\"main\")").expect("main");
        assert!(splash < main, "the splash window while the app starts");
        for step in ["window.show()", "window.unminimize()", "window.set_focus()"] {
            assert!(body.contains(step), "{step}");
        }
    }
}

/// The native avatar download contacts only an origin the build's policy lets
/// the webview contact (`allowed_avatar_base`), asks for the proxied image and
/// follows no redirect.
#[cfg(test)]
mod avatar_origin_tests {
    use super::*;
    use std::io::Write;
    use std::net::TcpListener;

    /// The shape of the official policy (tauri.conf.json): Tauri's own
    /// channel, the app's domain exactly and as a wildcard, its sockets.
    const POLICY: &str = "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; connect-src 'self' ipc: http://ipc.localhost https://voxium.app https://*.voxium.app wss://voxium.app wss://*.voxium.app; img-src 'self' blob: data: https://voxium.app https://*.voxium.app";

    fn check(policy: &str, base: &str, dev_loopback: bool) -> Result<String, String> {
        allowed_avatar_base(&connect_src_of_policy(policy), base, dev_loopback)
            .map(|url| url.to_string())
    }

    fn allows(policy: &str, base: &str) -> bool {
        check(policy, base, false).is_ok()
    }

    #[test]
    fn an_origin_the_policy_names_is_accepted_with_its_path() {
        for base in [
            "https://voxium.app/api/v1",
            "https://voxium.app/api/v1/",
            "https://voxium.app",
            "https://voxium.app/",
            "HTTPS://VOXIUM.APP/api/v1",
        ] {
            assert!(allows(POLICY, base), "{base}");
        }
        assert_eq!(
            check(POLICY, "https://voxium.app/api/v1", false),
            Ok("https://voxium.app/api/v1".to_string())
        );
    }

    #[test]
    fn another_host_scheme_or_port_is_refused() {
        for base in [
            "https://evil.example/api/v1",
            "https://evilvoxium.app/api/v1",
            "https://voxium.app.evil.example/api/v1",
            "https://voxium.app./api/v1",
            "http://voxium.app/api/v1",
            "wss://voxium.app",
            "ftp://voxium.app/api/v1",
            "https://voxium.app:8443/api/v1",
            "https://voxium.app:80/api/v1",
        ] {
            assert!(!allows(POLICY, base), "{base}");
        }
    }

    #[test]
    fn a_default_port_written_out_is_the_same_origin() {
        assert!(allows(POLICY, "https://voxium.app:443/api/v1"));
        let http = "connect-src http://chat.example.org";
        assert!(allows(http, "http://chat.example.org:80/api/v1"));
        assert!(allows(http, "http://chat.example.org/api/v1"));
        let spelled = "connect-src https://chat.example.org:443 http://lan.example:80";
        assert!(allows(spelled, "https://chat.example.org/api/v1"));
        assert!(allows(spelled, "http://lan.example/api/v1"));
        assert!(!allows(spelled, "https://lan.example/api/v1"));
    }

    #[test]
    fn a_self_hosted_policy_allows_its_own_api_origin() {
        // what scripts/tauriSelfHosted.mjs writes: the API origin as is, a
        // port when it is not the scheme's default
        let policy = "default-src 'self'; connect-src 'self' ipc: http://ipc.localhost http://10.0.0.5:3001 ws://10.0.0.5:3001 https://objects.example.org; img-src 'self' http://10.0.0.5:3001";
        assert!(allows(policy, "http://10.0.0.5:3001/api/v1"));
        assert!(!allows(policy, "http://10.0.0.5:3002/api/v1"));
        assert!(!allows(policy, "https://10.0.0.5:3001/api/v1"));
        // every origin the webview may contact, the object store included
        assert!(allows(policy, "https://objects.example.org"));
    }

    /// Only an exact origin matches: a wildcard source is no origin, so an
    /// API on a subdomain must be named in the policy by itself.
    #[test]
    fn a_wildcard_source_matches_nothing() {
        for base in [
            "https://api.voxium.app/api/v1",
            "https://a.b.voxium.app/api/v1",
            "https://*.voxium.app/api/v1",
        ] {
            assert!(!allows(POLICY, base), "{base}");
        }
        assert!(!allows("connect-src *", "https://voxium.app/api/v1"));
        assert!(!allows("connect-src https:", "https://voxium.app/api/v1"));
        assert!(!allows(
            "connect-src https://*",
            "https://voxium.app/api/v1"
        ));
        assert!(!allows(
            "connect-src https://voxium.app:*",
            "https://voxium.app/api/v1"
        ));
    }

    #[test]
    fn keywords_scheme_sources_sockets_and_tauris_channel_are_no_origin() {
        assert!(!allows("connect-src 'self'", "http://tauri.localhost/api"));
        assert!(!allows("connect-src 'self'", "https://tauri.localhost/api"));
        assert!(!allows(POLICY, "http://ipc.localhost/api"));
        assert!(!allows(POLICY, "http://IPC.localhost"));
        assert!(!allows(
            "connect-src https://ipc.localhost",
            "https://ipc.localhost"
        ));
        assert!(!allows("connect-src ipc:", "ipc://localhost/api"));
        assert!(!allows(
            "connect-src wss://chat.example.org ws://chat.example.org",
            "https://chat.example.org/api/v1"
        ));
        assert!(!allows(
            "connect-src wss://chat.example.org ws://chat.example.org",
            "http://chat.example.org/api/v1"
        ));
    }

    #[test]
    fn a_source_with_a_path_or_credentials_is_no_origin() {
        assert!(!allows(
            "connect-src https://voxium.app/api/",
            "https://voxium.app/api/v1"
        ));
        assert!(!allows(
            "connect-src https://user@voxium.app",
            "https://voxium.app/api/v1"
        ));
        assert!(!allows(
            "connect-src https://voxium.app?x",
            "https://voxium.app/api/v1"
        ));
    }

    #[test]
    fn a_base_with_credentials_a_query_or_a_fragment_is_refused() {
        for base in [
            "https://user@voxium.app/api/v1",
            "https://user:secret@voxium.app/api/v1",
            "https://:secret@voxium.app/api/v1",
            "https://voxium.app@evil.example/api/v1",
            "https://voxium.app/api/v1?x=1",
            "https://voxium.app/api/v1?",
            "https://voxium.app/api/v1#top",
        ] {
            assert!(!allows(POLICY, base), "{base}");
        }
    }

    #[test]
    fn what_is_not_an_absolute_http_url_is_refused() {
        for base in [
            "",
            "voxium.app/api/v1",
            "/api/v1",
            "//voxium.app/api/v1",
            "javascript:alert(1)",
            "file:///C:/Windows",
            "data:text/plain,x",
            "http://[::1]:3001/api/v1",
        ] {
            assert!(!allows(POLICY, base), "{base:?}");
            assert!(check(POLICY, base, true).is_err(), "{base:?}");
        }
    }

    #[test]
    fn the_policy_is_read_from_its_connect_src_alone() {
        // no connect-src: nothing, even when another directive names the host
        assert!(!allows(
            "default-src 'self' https://voxium.app; img-src https://voxium.app",
            "https://voxium.app/api/v1"
        ));
        assert!(!allows("", "https://voxium.app/api/v1"));
        // the directive name in any case, sources split on any blank
        assert!(allows(
            "CONNECT-SRC\thttps://voxium.app  ",
            "https://voxium.app/api/v1"
        ));
        // the first connect-src counts, as in a browser
        let twice = "connect-src https://a.example.org; connect-src https://b.example.org";
        assert!(allows(twice, "https://a.example.org"));
        assert!(!allows(twice, "https://b.example.org"));
    }

    #[test]
    fn a_debug_build_also_takes_http_on_loopback() {
        for base in [
            "http://localhost:3001/api/v1",
            "http://localhost/api/v1",
            "http://LOCALHOST:8080",
            "http://127.0.0.1:3001/api/v1",
        ] {
            assert!(check(POLICY, base, true).is_ok(), "{base}");
            assert!(check(POLICY, base, false).is_err(), "{base}");
        }
        for base in [
            "https://localhost:3001/api/v1",
            "https://127.0.0.1:3001/api/v1",
            "http://localhost.evil.example:3001/api/v1",
            "http://127.0.0.2:3001/api/v1",
            "http://10.0.0.5:3001/api/v1",
            "http://localhost:3001@evil.example/api/v1",
            "http://evil.example/?localhost",
        ] {
            assert!(check(POLICY, base, true).is_err(), "{base}");
        }
    }

    #[test]
    fn the_policy_map_form_is_read_too() {
        use std::collections::HashMap;
        use tauri::utils::config::{Csp, CspDirectiveSources};

        let inline = Csp::DirectiveMap(HashMap::from([
            (
                "connect-src".to_string(),
                CspDirectiveSources::Inline("'self' https://chat.example.org".to_string()),
            ),
            (
                "img-src".to_string(),
                CspDirectiveSources::Inline("https://img.example.org".to_string()),
            ),
        ]));
        let list = Csp::DirectiveMap(HashMap::from([(
            "connect-src".to_string(),
            CspDirectiveSources::List(vec![
                "'self'".to_string(),
                "https://chat.example.org".to_string(),
            ]),
        )]));
        for csp in [&inline, &list] {
            let sources = connect_src_of(Some(csp));
            assert!(allowed_avatar_base(&sources, "https://chat.example.org/api", false).is_ok());
            assert!(allowed_avatar_base(&sources, "https://img.example.org/api", false).is_err());
        }
        let string = Csp::Policy("connect-src https://chat.example.org".to_string());
        assert_eq!(connect_src_of(Some(&string)), ["https://chat.example.org"]);
        assert!(connect_src_of(None).is_empty());
    }

    /// The policy the official release is built with, read the way the app
    /// reads its compiled configuration: it names the app's domain exactly.
    #[test]
    fn the_official_policy_allows_the_official_api_and_nothing_else() {
        let conf: serde_json::Value = serde_json::from_str(include_str!("../tauri.conf.json"))
            .expect("tauri.conf.json is JSON");
        let csp: tauri::utils::config::Csp =
            serde_json::from_value(conf["app"]["security"]["csp"].clone()).expect("a policy");
        let sources = connect_src_of(Some(&csp));
        assert!(allowed_avatar_base(&sources, "https://voxium.app/api/v1", false).is_ok());
        for base in [
            "http://ipc.localhost/api/v1",
            "https://api.voxium.app/api/v1",
            "http://localhost:3001/api/v1",
        ] {
            assert!(
                allowed_avatar_base(&sources, base, false).is_err(),
                "{base}"
            );
        }
    }

    #[test]
    fn the_request_asks_for_the_proxied_image_on_the_checked_base() {
        let key = "avatars/u-1_x.webp";
        for (base, url) in [
            (
                "https://voxium.app/api/v1",
                "https://voxium.app/api/v1/uploads/avatars/u-1_x.webp?inline",
            ),
            (
                "https://voxium.app/api/v1/",
                "https://voxium.app/api/v1/uploads/avatars/u-1_x.webp?inline",
            ),
            (
                "https://voxium.app:443",
                "https://voxium.app/uploads/avatars/u-1_x.webp?inline",
            ),
            (
                "http://10.0.0.5:3001/api/v1",
                "http://10.0.0.5:3001/api/v1/uploads/avatars/u-1_x.webp?inline",
            ),
        ] {
            let checked = tauri::Url::parse(base).expect("a URL");
            let built = avatar_url(&checked, key).expect("built");
            assert_eq!(built.as_str(), url);
            assert_eq!(http_origin(&built), http_origin(&checked));
        }
        let icon = avatar_url(
            &tauri::Url::parse("https://voxium.app/api/v1").expect("a URL"),
            "server-icons/s-9.webp",
        )
        .expect("built");
        assert_eq!(
            icon.as_str(),
            "https://voxium.app/api/v1/uploads/server-icons/s-9.webp?inline"
        );
    }

    // ── The download itself, against a server on this machine ──────────────

    const PNG: &[u8] = b"\x89PNG\r\n\x1a\n\0\0\0\rIHDR";

    /// Answer one request with `response` and hand back the request head.
    fn serve_once(response: Vec<u8>) -> (String, std::thread::JoinHandle<String>) {
        let listener = TcpListener::bind("127.0.0.1:0").expect("a port");
        let base = format!("http://{}", listener.local_addr().expect("its address"));
        let served = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().expect("the request");
            let mut head = Vec::new();
            let mut byte = [0u8; 1];
            while !head.ends_with(b"\r\n\r\n") {
                if stream.read(&mut byte).expect("the request head") == 0 {
                    break;
                }
                head.push(byte[0]);
            }
            stream.write_all(&response).expect("the answer");
            String::from_utf8_lossy(&head).into_owned()
        });
        (base, served)
    }

    fn answer(status: &str, headers: &str, body: &[u8]) -> Vec<u8> {
        let mut out = format!(
            "HTTP/1.1 {status}\r\n{headers}Content-Length: {}\r\nConnection: close\r\n\r\n",
            body.len()
        )
        .into_bytes();
        out.extend_from_slice(body);
        out
    }

    #[test]
    fn the_image_is_fetched_with_inline_from_the_base_it_was_given() {
        let (base, served) = serve_once(answer("200 OK", "Content-Type: image/png\r\n", PNG));
        let url = avatar_url(
            &tauri::Url::parse(&format!("{base}/api/v1")).expect("a URL"),
            "avatars/u-1.webp",
        )
        .expect("built");
        assert_eq!(download_avatar(&url), Ok(PNG.to_vec()));
        let head = served.join().expect("served");
        assert!(
            head.starts_with("GET /api/v1/uploads/avatars/u-1.webp?inline HTTP/1.1\r\n"),
            "{head}"
        );
    }

    #[test]
    fn a_redirect_is_a_failure_and_is_not_followed() {
        let elsewhere = TcpListener::bind("127.0.0.1:0").expect("a port");
        elsewhere.set_nonblocking(true).expect("non-blocking");
        let location = format!(
            "Location: http://{}/avatar.png\r\n",
            elsewhere.local_addr().expect("its address")
        );
        for status in [
            "302 Found",
            "301 Moved Permanently",
            "307 Temporary Redirect",
        ] {
            let (base, served) = serve_once(answer(status, &location, b""));
            let url = avatar_url(
                &tauri::Url::parse(&base).expect("a URL"),
                "avatars/u-1.webp",
            )
            .expect("built");
            assert_eq!(
                download_avatar(&url),
                Err("Avatar download failed".to_string()),
                "{status}"
            );
            served.join().expect("served");
        }
        // nothing ever connected to where the redirects pointed
        assert_eq!(
            elsewhere.accept().map(|_| ()).unwrap_err().kind(),
            std::io::ErrorKind::WouldBlock
        );
    }

    #[test]
    fn an_answer_that_is_not_a_small_image_is_refused() {
        for (response, error) in [
            (
                answer("404 Not Found", "", b"missing"),
                "Avatar download failed",
            ),
            (answer("204 No Content", "", b""), "Invalid image data"),
            (
                answer("200 OK", "Content-Type: image/png\r\n", b"<html>"),
                "Invalid image data",
            ),
            (
                answer("200 OK", "", &[PNG, &vec![0u8; 1_048_577]].concat()),
                "Avatar too large",
            ),
        ] {
            let (base, served) = serve_once(response);
            let url = avatar_url(
                &tauri::Url::parse(&base).expect("a URL"),
                "avatars/u-1.webp",
            )
            .expect("built");
            assert_eq!(download_avatar(&url), Err(error.to_string()));
            let _ = served.join();
        }
    }

    /// The command checks the base before anything else, the cache included:
    /// a refused base never reaches `cache_avatar_to_file`.
    #[test]
    fn the_command_checks_the_base_before_the_cache_and_the_download() {
        let source = include_str!("lib.rs");
        let code = &source[..source
            .find("\n#[cfg(test)]")
            .expect("the tests follow the code")];
        let command = &code[code.find("fn notify_with_avatar(").expect("the command")..];
        let checked = command
            .find("allowed_avatar_base(connect_src, base, cfg!(debug_assertions))?")
            .expect("the base is checked, and a refusal returns");
        let cached = command
            .find("cache_avatar_to_file(&base, key)")
            .expect("the cache");
        assert!(checked < cached);
        assert!(
            command[..checked].contains("connect_src_of(app.config().app.security.csp.as_ref())")
        );
        // the only caller of the cache, the only builder of the request
        assert_eq!(code.matches("cache_avatar_to_file(").count(), 2);
        assert_eq!(code.matches("download_avatar(").count(), 2);
        assert_eq!(code.matches("ureq::").count(), 1);
    }
}

/// No command blocks the thread that paints the window: every command is
/// `async`, and the ones that block (the keychain, the avatar download, its
/// file and the toast) do it on the blocking pool, a join failure answered
/// as an error string.
#[cfg(test)]
mod blocking_commands_tests {
    #[test]
    fn every_command_is_async_and_blocks_only_on_the_blocking_pool() {
        let source = include_str!("lib.rs");
        let code = &source[..source
            .find("\n#[cfg(test)]")
            .expect("the tests follow the code")];

        let list = &code
            [code.find("generate_handler![").expect("the handler") + "generate_handler![".len()..];
        let list = &list[..list.find(']').expect("its end")];
        let commands: Vec<&str> = list
            .split(',')
            .map(str::trim)
            .filter(|name| !name.is_empty())
            .collect();
        assert_eq!(commands.len(), 7, "{commands:?}");

        for name in commands {
            let start = code
                .find(&format!("async fn {name}("))
                .unwrap_or_else(|| panic!("{name} is async"));
            let body = &code[start..start + code[start..].find("\n}\n").expect("its end")];
            assert!(
                body.contains("tauri::async_runtime::spawn_blocking(move ||"),
                "{name} blocks on the blocking pool"
            );
            assert!(
                body.contains(".map_err(|e| e.to_string())?"),
                "{name} answers a join failure as an error"
            );
        }
        assert!(!code.contains("#[tauri::command]\nfn "));
    }
}
