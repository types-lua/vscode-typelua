# Changelog

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
