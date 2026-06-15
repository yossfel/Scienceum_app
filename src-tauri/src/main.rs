// Scienceum desktop shell.
//
// Tauri (this Rust process) owns the window and a long-lived Python sidecar
// (`kernel_server.py`) that wraps the SymbolicKernel. The frontend calls the
// `eval_cell` / `reset_kernel` commands; we relay one JSON line to the sidecar
// and return the parsed reply. The kernel is stateful, so a Mutex serialises
// access and assignments persist across cells.

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::io::{BufRead, BufReader, Write};
use std::path::PathBuf;
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;

use serde_json::{json, Value};
use tauri::Manager;

/// The live connection to the Python kernel process.
struct Sidecar {
    child: Child,
    stdin: ChildStdin,
    reader: BufReader<std::process::ChildStdout>,
    seq: AtomicU64,
}

impl Sidecar {
    fn spawn(script: &PathBuf) -> Result<Self, String> {
        let python = std::env::var("SCIENCEUM_PYTHON").unwrap_or_else(|_| "python".into());
        let mut child = Command::new(&python)
            .arg(script)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit())
            .spawn()
            .map_err(|e| format!("failed to launch `{python} {script:?}`: {e}"))?;

        let stdin = child.stdin.take().ok_or("no stdin on kernel")?;
        let stdout = child.stdout.take().ok_or("no stdout on kernel")?;
        Ok(Sidecar {
            child,
            stdin,
            reader: BufReader::new(stdout),
            seq: AtomicU64::new(1),
        })
    }

    /// Send one request object and read exactly one reply line back.
    fn request(&mut self, mut msg: Value) -> Result<Value, String> {
        let id = self.seq.fetch_add(1, Ordering::Relaxed);
        msg["id"] = json!(id);
        let line = serde_json::to_string(&msg).map_err(|e| e.to_string())?;

        self.stdin
            .write_all(line.as_bytes())
            .and_then(|_| self.stdin.write_all(b"\n"))
            .and_then(|_| self.stdin.flush())
            .map_err(|e| format!("kernel write failed: {e}"))?;

        let mut reply = String::new();
        let n = self
            .reader
            .read_line(&mut reply)
            .map_err(|e| format!("kernel read failed: {e}"))?;
        if n == 0 {
            return Err("kernel closed the connection".into());
        }
        serde_json::from_str(&reply).map_err(|e| format!("bad kernel reply: {e}"))
    }
}

impl Drop for Sidecar {
    fn drop(&mut self) {
        // Don't leave an orphaned Python process behind when the app exits.
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

struct KernelState(Mutex<Sidecar>);

#[tauri::command]
fn eval_cell(state: tauri::State<KernelState>, src: String) -> Result<Value, String> {
    let mut sc = state.0.lock().map_err(|_| "kernel lock poisoned")?;
    sc.request(json!({ "op": "eval", "src": src }))
}

#[tauri::command]
fn reset_kernel(state: tauri::State<KernelState>) -> Result<Value, String> {
    let mut sc = state.0.lock().map_err(|_| "kernel lock poisoned")?;
    sc.request(json!({ "op": "reset" }))
}

/// Locate `kernel_server.py`: env override, else next to the bundled resources,
/// else the dev path (../kernel_server.py relative to this crate).
fn kernel_script(app: &tauri::App) -> PathBuf {
    if let Ok(p) = std::env::var("SCIENCEUM_KERNEL") {
        return PathBuf::from(p);
    }
    if let Ok(res) = app.path().resource_dir() {
        let bundled = res.join("kernel_server.py");
        if bundled.exists() {
            return bundled;
        }
    }
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("kernel_server.py")
}

fn main() {
    tauri::Builder::default()
        .setup(|app| {
            let script = kernel_script(app);
            let sidecar = Sidecar::spawn(&script)
                .unwrap_or_else(|e| panic!("could not start kernel: {e}"));
            app.manage(KernelState(Mutex::new(sidecar)));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![eval_cell, reset_kernel])
        .run(tauri::generate_context!())
        .expect("error while running Scienceum");
}
