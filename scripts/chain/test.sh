#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../.."
# rustup honors the committed toolchain file. A system Cargo can also use that compiler via PATH.
export PATH="$HOME/.cargo/bin:$PATH"
cargo fmt --all -- --check
cargo test -p counterparty-vault --locked
RUSTFLAGS='--cfg near -C target-cpu=mvp' cargo build -p counterparty-vault -p receiver-fixture --target wasm32-unknown-unknown --release --locked
cargo test -p chain-integration --test sandbox --locked -- --ignored --nocapture
