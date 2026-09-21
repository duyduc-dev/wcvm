# wcvm

Browser WebContainer-style runtime. See the [repository README](../../README.md)
for usage and [`PLAN.md`](../../PLAN.md) for what is implemented and what is next.

Public API today: `boot(options?)` -> `{ spawn, diagnostics, ready }`, plus
`WcvmError` and the `IProcess` / `IProcessExit` / `ISpawnOptions` types.
