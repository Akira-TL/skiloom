use std::env;
use std::fs::{File, OpenOptions, TryLockError};
use std::io::{self, Read, Write};
use std::path::PathBuf;
use std::process::ExitCode;

const PROTOCOL_VERSION: &str = "1";
const ACQUIRED: &str = "SKILOOM-LOCK-V1 ACQUIRED";
const CONTENDED: &str = "SKILOOM-LOCK-V1 CONTENDED";
const UNSUPPORTED: &str = "SKILOOM-LOCK-V1 UNSUPPORTED";

fn main() -> ExitCode {
    match run(env::args_os().skip(1)) {
        Ok(()) => ExitCode::SUCCESS,
        Err(message) => {
            eprintln!("skiloom-lock: {message}");
            ExitCode::FAILURE
        }
    }
}

fn run(args: impl Iterator<Item = std::ffi::OsString>) -> Result<(), String> {
    let lock_path = parse_args(args)?;
    let file = open_lock_file(&lock_path)?;

    match classify_lock_attempt(file.try_lock()) {
        Ok(LockAttempt::Acquired) => hold_until_parent_eof(file),
        Ok(LockAttempt::Contended) => write_handshake(CONTENDED),
        Ok(LockAttempt::Unsupported) => write_handshake(UNSUPPORTED),
        Err(error) => Err(format!(
            "failed to acquire OS lock on {}: {error}",
            lock_path.display()
        )),
    }
}

fn parse_args(args: impl Iterator<Item = std::ffi::OsString>) -> Result<PathBuf, String> {
    let args: Vec<_> = args.collect();
    if args.len() != 4 || args[0] != "--protocol" || args[2] != "--path" {
        return Err("expected --protocol 1 --path <absolute-lock-path>".to_owned());
    }

    if args[1] != PROTOCOL_VERSION {
        return Err(format!(
            "unsupported protocol version: {}",
            args[1].to_string_lossy()
        ));
    }

    let path = PathBuf::from(&args[3]);
    if !path.is_absolute() {
        return Err("lock path must be absolute".to_owned());
    }

    Ok(path)
}

fn open_lock_file(path: &PathBuf) -> Result<File, String> {
    OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .open(path)
        .map_err(|error| format!("failed to open {}: {error}", path.display()))
}

fn hold_until_parent_eof(file: File) -> Result<(), String> {
    write_handshake(ACQUIRED)?;

    let mut stdin = io::stdin().lock();
    let mut buffer = [0_u8; 1024];
    loop {
        match stdin.read(&mut buffer) {
            Ok(0) => return Ok(()),
            Ok(_) => {}
            Err(error) if error.kind() == io::ErrorKind::Interrupted => {}
            Err(error) => {
                drop(file);
                return Err(format!("failed to read parent lifetime channel: {error}"));
            }
        }
    }
}

fn write_handshake(message: &str) -> Result<(), String> {
    let mut stdout = io::stdout().lock();
    writeln!(stdout, "{message}").map_err(|error| format!("failed to write handshake: {error}"))?;
    stdout
        .flush()
        .map_err(|error| format!("failed to flush handshake: {error}"))
}

#[derive(Debug, Eq, PartialEq)]
enum LockAttempt {
    Acquired,
    Contended,
    Unsupported,
}

fn classify_lock_attempt(result: Result<(), TryLockError>) -> Result<LockAttempt, io::Error> {
    match result {
        Ok(()) => Ok(LockAttempt::Acquired),
        Err(TryLockError::WouldBlock) => Ok(LockAttempt::Contended),
        Err(TryLockError::Error(error)) if error.kind() == io::ErrorKind::Unsupported => {
            Ok(LockAttempt::Unsupported)
        }
        Err(TryLockError::Error(error)) => Err(error),
    }
}

#[cfg(test)]
mod tests {
    use super::{LockAttempt, classify_lock_attempt};
    use std::fs::TryLockError;
    use std::io;

    #[test]
    fn lock_attempt_classification_keeps_unsupported_distinct_from_contention() {
        assert_eq!(
            classify_lock_attempt(Ok(())).expect("acquired classification"),
            LockAttempt::Acquired
        );
        assert_eq!(
            classify_lock_attempt(Err(TryLockError::WouldBlock))
                .expect("contention classification"),
            LockAttempt::Contended
        );
        assert_eq!(
            classify_lock_attempt(Err(TryLockError::Error(io::Error::from(
                io::ErrorKind::Unsupported
            ))))
            .expect("unsupported classification"),
            LockAttempt::Unsupported
        );
        assert!(
            classify_lock_attempt(Err(TryLockError::Error(io::Error::from(
                io::ErrorKind::PermissionDenied
            ))))
            .is_err()
        );
        assert_eq!(super::UNSUPPORTED, "SKILOOM-LOCK-V1 UNSUPPORTED");
    }
}
