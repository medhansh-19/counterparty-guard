# Receiver fixture

Project-owned synchronous demonstration target. Initialize with `new({})`; the one supported payable method is `record({memo})`. It stores a <=256 UTF-16-unit memo, increments `get_count()`, exposes `get_memo()` and returns `"recorded"`. The labelled test memo `fixture:fail` deliberately panics, proving no state/deposit change for a failed atomic action. It schedules no downstream promises.

The vault independently enforces exact raw argument bytes, a literal `memo` key, no unknown/duplicate keys, receiver/method/gas/deposit limits and the finalized result. It does not grant arbitrary call authority. Old offline UI fixtures that say `accept_memo` are not deployment configuration; the actual supported v1 method is `record`.

Build and test with `pnpm test:e2e` or the commands in [the vault README](../vault/README.md). The sandbox upgrade test redeploys this Wasm with a different valid custom section: real code identity changes, while the fixture operation remains synchronous. It establishes the prior identity from an actual SDK call's finalized receipt, then proves `CODE_CHANGED` requires new approval.
