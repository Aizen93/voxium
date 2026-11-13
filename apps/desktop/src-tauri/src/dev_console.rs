//! Debug builds on Windows only: a Ctrl-C in the `pnpm dev` / `tauri dev`
//! console ends the app with exit code 0.
//!
//! A debug build is a console program (main.rs sets the "windows" subsystem
//! for release builds only), and Windows delivers CTRL_C_EVENT to every
//! process attached to that console. Without a handler of its own the app is
//! ended with STATUS_CONTROL_C_EXIT (0xC000013A); cargo, which ignores the
//! Ctrl-C while its child runs, then reports "process didn't exit
//! successfully" and the Tauri CLI prints `[tauri] error`. Release builds have
//! no console and never compile this module.

use windows_sys::core::BOOL;
use windows_sys::Win32::System::Console::{
    SetConsoleCtrlHandler, CTRL_BREAK_EVENT, CTRL_CLOSE_EVENT, CTRL_C_EVENT,
};

/// The console events that end the app quietly. Anything else (log-off,
/// shutdown) is left to the next handler, Windows' default.
fn ends_the_process(ctrl_type: u32) -> bool {
    matches!(
        ctrl_type,
        CTRL_C_EVENT | CTRL_BREAK_EVENT | CTRL_CLOSE_EVENT
    )
}

/// Runs on a thread Windows creates for the event.
unsafe extern "system" fn on_console_event(ctrl_type: u32) -> BOOL {
    if ends_the_process(ctrl_type) {
        std::process::exit(0);
    }
    0
}

/// Installs the handler; a failure is logged and the app runs on without it.
pub fn exit_cleanly_on_ctrl_c() {
    // SAFETY: `on_console_event` has the PHANDLER_ROUTINE signature and reads
    // no shared state; Windows calls it on a thread of its own.
    if unsafe { SetConsoleCtrlHandler(Some(on_console_event), 1) } == 0 {
        eprintln!(
            "[Voxium] Could not install the console Ctrl-C handler: {}",
            std::io::Error::last_os_error()
        );
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use windows_sys::Win32::System::Console::{CTRL_LOGOFF_EVENT, CTRL_SHUTDOWN_EVENT};

    #[test]
    fn only_ctrl_c_break_and_close_end_the_process() {
        assert!(ends_the_process(CTRL_C_EVENT));
        assert!(ends_the_process(CTRL_BREAK_EVENT));
        assert!(ends_the_process(CTRL_CLOSE_EVENT));
        assert!(!ends_the_process(CTRL_LOGOFF_EVENT));
        assert!(!ends_the_process(CTRL_SHUTDOWN_EVENT));
        assert!(!ends_the_process(3)); // unassigned
    }
}
