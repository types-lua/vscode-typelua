# Changelog

## 0.2.0

- Test Explorer: discovers `tests/**` and `*_test.tl` cases through
  `tlua test --list`, with Run and Debug profiles, per-case results parsed
  from `--format=json`, and refresh on file changes.
- Breakpoint debugging: contributes the `typelua` debugger backed by
  `tlua dap` (source-mapped breakpoints, step in/over/out, call stack,
  locals, program output). Debugging a test reports pass/fail back to the
  Testing view via a custom DAP event.
- Commands: Run File, Debug File, Check Project, Build Project, Run All
  Tests, Run Test File, Run Example…; editor title/context menus.
- Settings: `typelua.lua.path`, `typelua.run.check`, `typelua.debug.check`,
  `typelua.test.args`.
- Grammar: async/await/spawn/select/case/default, `chan` and FFI types,
  `->`/`=>` operators; new snippets for tests, relative imports, async,
  defer, macros and select.
- Fix bundled-server arch names (`x64` → `amd64`) to match release assets.
- Tests: manifest checks for the debugger, grammar coverage for the new
  keywords, and a portable example-corpus path.

## 0.1.3

- Friendly bottom-right notifications whenever the language server has no
  effect: missing/unusable executable, spawn failure, startup watchdog
  (`typelua.server.startTimeout`, default 10s), repeated crashes, and
  unexpected disconnects — each with Show Output / Open Settings /
  Retry-or-Restart actions and log lines in the output channel.
- Close notifications are throttled (30s) and stale start attempts can no
  longer popup or touch the status bar.

## 0.1.2

- Fix: the language client runtime (`vscode-languageclient`) was stripped
  from the package by an over-broad `.vscodeignore`, so activation failed
  and every command errored. Runtime dependencies are now allow-listed.
- Fix: command titles no longer duplicate the category prefix.
- Restart command now reports failures explicitly instead of rejecting.

## 0.1.1

- Activation fallback: the extension also activates when the workspace
  contains `*.tl` files, so the status bar and commands appear even before a
  `.tl` file sets the language mode.
- New manifest consistency tests (activation events, entrypoint, commands,
  settings wiring).

## 0.1.0

- Initial release.
- TextMate grammar for TypeLua (`.tl`): Lua 5.4 + `class`/`interface`/`enum`/
  `type`/`macro`/`defer`/`errdefer`, generics, conditions, attributes.
- Language configuration: comments, brackets, indentation, folding markers.
- 17 snippets for declarations, control flow, macros, imports.
- LSP client over stdio (`tlua lsp`): diagnostics, completion (incl. member
  `obj.`/`obj:`), hover, definition, references, rename, document symbols.
- Server resolution (settings → bundled → PATH), crash budget with
  auto-restart, status bar, restart/show-output commands, trace setting.
