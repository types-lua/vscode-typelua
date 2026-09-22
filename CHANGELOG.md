# Changelog

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
