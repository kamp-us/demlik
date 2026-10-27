use std::{env, path::PathBuf, process::Command};

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let manifest = PathBuf::from(env::var_os("CARGO_MANIFEST_DIR").ok_or("missing manifest path")?);
    let root = manifest
        .parent()
        .and_then(|p| p.parent())
        .ok_or("missing workspace root")?;
    let python = env::var_os("DEMLIK_ICU77_PYTHON").ok_or(
        "ICU77 preparation is required: see crates/code-graph/ICU77-BUILD.md and set DEMLIK_ICU77_PYTHON",
    )?;
    let mut verify = Command::new(python);
    verify
        .env_clear()
        .env("PATH", "/usr/bin:/bin:/usr/sbin:/sbin");
    for key in [
        "LANG",
        "LC_ALL",
        "TZ",
        "TMPDIR",
        "DEMLIK_ICU77_PREPARED",
        "RUST_ICU_LINK_SEARCH_DIR",
        "RUST_ICU_MAJOR_VERSION_NUMBER",
        "CARGO_TARGET_DIR",
        "CARGO_BUILD_TARGET_DIR",
        "CARGO_BUILD_BUILD_DIR",
        "DEMLIK_MUTATION_TARGET_DIR",
    ] {
        if let Some(value) = env::var_os(key) {
            verify.env(key, value);
        }
    }
    let status = verify
        .arg(root.join("tools/icu77/prepare.py"))
        .arg("verify")
        .arg("--host")
        .arg(env::var("HOST")?)
        .arg("--target")
        .arg(env::var("TARGET")?)
        .status()?;
    if !status.success() {
        return Err(
            "ICU77 preparation verification failed; native tool diagnostics are above".into(),
        );
    }
    for key in [
        "DEMLIK_ICU77_PYTHON",
        "DEMLIK_ICU77_PREPARED",
        "RUST_ICU_LINK_SEARCH_DIR",
        "RUST_ICU_MAJOR_VERSION_NUMBER",
        "CARGO_TARGET_DIR",
        "CARGO_BUILD_TARGET_DIR",
        "CARGO_BUILD_BUILD_DIR",
        "DEMLIK_MUTATION_TARGET_DIR",
    ] {
        println!("cargo:rerun-if-env-changed={key}");
    }
    println!(
        "cargo:rerun-if-changed={}",
        root.join("tools/icu77/prepare.py").display()
    );
    println!(
        "cargo:rerun-if-changed={}",
        root.join("tools/icu77/inputs.json").display()
    );
    println!(
        "cargo:rerun-if-changed={}",
        root.join("Cargo.lock").display()
    );
    println!(
        "cargo:rerun-if-changed={}",
        manifest.join("Cargo.toml").display()
    );
    if let Some(stamp) = env::var_os("DEMLIK_ICU77_PREPARED") {
        println!("cargo:rerun-if-changed={}", PathBuf::from(stamp).display());
    }
    Ok(())
}
