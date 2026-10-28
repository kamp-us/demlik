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
    // BasicTimeZone's FORMER/FORMER operation is C++ only. Compile this narrow
    // bridge against the already-verified owning tree's static ICU77 install.
    let source = manifest.join("src/hotspots/timezone.cc");
    let libraries = PathBuf::from(
        env::var_os("RUST_ICU_LINK_SEARCH_DIR").ok_or("missing private ICU77 library directory")?,
    );
    let includes = libraries
        .parent()
        .ok_or("missing ICU77 install")?
        .join("include");
    let output = PathBuf::from(env::var_os("OUT_DIR").ok_or("missing Cargo OUT_DIR")?);
    let object = output.join("hotspots-timezone77.o");
    let archive = output.join("libdemlik_hotspots_timezone77.a");
    let status = Command::new("/usr/bin/clang++")
        .env_clear()
        .env("PATH", "/usr/bin:/bin:/usr/sbin:/sbin")
        .env("TMPDIR", root.join("target/tmp"))
        .args([
            "-std=c++17",
            "-O2",
            "-g0",
            "-fno-exceptions",
            "-fno-rtti",
            "-c",
        ])
        .arg(&source)
        .arg("-I")
        .arg(includes)
        .arg("-o")
        .arg(&object)
        .status()?;
    if !status.success() {
        return Err("ICU77 timezone bridge compilation failed".into());
    }
    let status = Command::new("/usr/bin/ar")
        .env_clear()
        .env("PATH", "/usr/bin:/bin:/usr/sbin:/sbin")
        .env("TMPDIR", root.join("target/tmp"))
        .args(["crs"])
        .arg(&archive)
        .arg(object)
        .status()?;
    if !status.success() {
        return Err("ICU77 timezone bridge archive failed".into());
    }
    println!("cargo:rerun-if-changed={}", source.display());
    println!("cargo:rustc-link-search=native={}", output.display());
    println!("cargo:rustc-link-lib=static=demlik_hotspots_timezone77");
    println!("cargo:rustc-link-lib=c++");
    Ok(())
}
