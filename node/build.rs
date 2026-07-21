fn main() {
    napi_build::setup();
    println!(
        "cargo:rustc-env=WATCHBOUND_TARGET_TRIPLE={}",
        std::env::var("TARGET").expect("Cargo must provide TARGET to build scripts")
    );
    println!(
        "cargo:rustc-env=WATCHBOUND_BUILD_PROFILE={}",
        std::env::var("PROFILE").expect("Cargo must provide PROFILE to build scripts")
    );
}
