//! `cargo run --features devbridge --bin mobyd-devbridge [port] [config-dir]`
fn main() {
    let mut args = std::env::args().skip(1);
    let port = args.next().and_then(|p| p.parse().ok()).unwrap_or(1430);
    let dir = args.next().map(std::path::PathBuf::from).unwrap_or_else(|| std::env::temp_dir().join("mobyd-devbridge"));
    if let Err(e) = mobyd_lib::devbridge::serve(port, dir) {
        eprintln!("devbridge failed: {e}");
        std::process::exit(1);
    }
}
