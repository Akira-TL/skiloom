use std::fs;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::thread;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

const ACQUIRED: &str = "SKILOOM-LOCK-V1 ACQUIRED\n";
const CONTENDED: &str = "SKILOOM-LOCK-V1 CONTENDED\n";
static TEMP_COUNTER: AtomicU64 = AtomicU64::new(0);

#[test]
fn contention_is_non_blocking_and_eof_releases_lock() {
    let temp = TestDirectory::new();
    let lock_path = temp.path().join("operation.lock");
    let mut holder = Holder::acquire(&lock_path);

    thread::sleep(Duration::from_millis(40));
    assert!(holder.child.try_wait().expect("holder status").is_none());

    let contender = run_helper(&lock_path);
    assert!(contender.status.success());
    assert_eq!(String::from_utf8_lossy(&contender.stdout), CONTENDED);
    assert!(contender.stderr.is_empty());

    holder.release();

    let reacquired = run_helper(&lock_path);
    assert!(reacquired.status.success());
    assert_eq!(String::from_utf8_lossy(&reacquired.stdout), ACQUIRED);
}

#[test]
fn forced_helper_termination_releases_os_lock() {
    let temp = TestDirectory::new();
    let lock_path = temp.path().join("operation.lock");
    let mut holder = Holder::acquire(&lock_path);

    holder.child.kill().expect("kill holder");
    let status = holder.child.wait().expect("wait for killed holder");
    assert!(!status.success());
    drop(holder.stdin.take());

    let reacquired = run_helper(&lock_path);
    assert!(reacquired.status.success());
    assert_eq!(String::from_utf8_lossy(&reacquired.stdout), ACQUIRED);
}

#[test]
fn residual_lock_file_is_not_lock_authority() {
    let temp = TestDirectory::new();
    let lock_path = temp.path().join("operation.lock");
    fs::write(&lock_path, b"diagnostic residue is not authority\n").expect("write residual file");

    let acquired = run_helper(&lock_path);
    assert!(acquired.status.success());
    assert_eq!(String::from_utf8_lossy(&acquired.stdout), ACQUIRED);
    assert!(lock_path.exists());
}

#[test]
fn invalid_protocol_relative_path_and_open_errors_never_masquerade_as_contention() {
    let temp = TestDirectory::new();
    let absolute_path = temp.path().join("operation.lock");

    let invalid_protocol = Command::new(binary())
        .args(["--protocol", "2", "--path"])
        .arg(&absolute_path)
        .output()
        .expect("run invalid protocol");
    assert!(!invalid_protocol.status.success());
    assert!(invalid_protocol.stdout.is_empty());
    assert!(
        String::from_utf8_lossy(&invalid_protocol.stderr).contains("unsupported protocol version")
    );

    let relative_path = Command::new(binary())
        .args(["--protocol", "1", "--path", "relative.lock"])
        .output()
        .expect("run relative path");
    assert!(!relative_path.status.success());
    assert!(relative_path.stdout.is_empty());
    assert!(String::from_utf8_lossy(&relative_path.stderr).contains("lock path must be absolute"));

    let missing_parent = temp.path().join("missing").join("operation.lock");
    let open_error = Command::new(binary())
        .args(["--protocol", "1", "--path"])
        .arg(&missing_parent)
        .output()
        .expect("run open error");
    assert!(!open_error.status.success());
    assert!(open_error.stdout.is_empty());
    assert!(String::from_utf8_lossy(&open_error.stderr).contains("failed to open"));

    for output in [&invalid_protocol, &relative_path, &open_error] {
        assert_ne!(String::from_utf8_lossy(&output.stdout), CONTENDED);
    }
}

struct Holder {
    child: Child,
    stdin: Option<ChildStdin>,
}

impl Holder {
    fn acquire(lock_path: &Path) -> Self {
        let mut child = Command::new(binary())
            .args(["--protocol", "1", "--path"])
            .arg(lock_path)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .expect("spawn holder");
        let stdin = child.stdin.take().expect("holder stdin");
        let stdout = child.stdout.take().expect("holder stdout");
        let mut reader = BufReader::new(stdout);
        let mut handshake = String::new();
        reader.read_line(&mut handshake).expect("read handshake");
        assert_eq!(handshake, ACQUIRED);

        Self {
            child,
            stdin: Some(stdin),
        }
    }

    fn release(mut self) {
        drop(self.stdin.take());
        let status = self.child.wait().expect("wait for holder release");
        assert!(status.success());
    }
}

impl Drop for Holder {
    fn drop(&mut self) {
        drop(self.stdin.take());
        if self.child.try_wait().ok().flatten().is_none() {
            let _ = self.child.kill();
            let _ = self.child.wait();
        }
    }
}

fn run_helper(lock_path: &Path) -> std::process::Output {
    Command::new(binary())
        .args(["--protocol", "1", "--path"])
        .arg(lock_path)
        .stdin(Stdio::null())
        .output()
        .expect("run helper")
}

fn binary() -> &'static str {
    env!("CARGO_BIN_EXE_skiloom-lock")
}

struct TestDirectory {
    path: PathBuf,
}

impl TestDirectory {
    fn new() -> Self {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system time")
            .as_nanos();
        let counter = TEMP_COUNTER.fetch_add(1, Ordering::Relaxed);
        let path = std::env::temp_dir().join(format!(
            "skiloom-lock-test-{}-{nonce}-{counter}",
            std::process::id()
        ));
        fs::create_dir(&path).expect("create test directory");
        Self { path }
    }

    fn path(&self) -> &Path {
        &self.path
    }
}

impl Drop for TestDirectory {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.path);
    }
}
