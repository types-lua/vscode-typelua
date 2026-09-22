# TypeLua for VS Code

TypeLua language support for Visual Studio Code: syntax highlighting,
snippets, and full IDE features powered by the `tlua` language server.

## Features

| Feature | How |
|---|---|
| Syntax highlighting | TextMate grammar (`source.tlua`) covering Lua 5.4 plus TypeLua extensions: `class`/`interface`/`enum`/`type`/`macro`, generics, annotations (`<const>`/`<close>`), long strings/comments, labels |
| Real-time diagnostics | Errors and warnings as you type (`TL1xxx`–`TL4xxx` codes, source `tlua`) |
| Intelligent completion | Scope variables, types, keywords, and member-aware `obj.` / `obj:` lists |
| Hover | Symbol kind + inferred type in a `tlua` code block |
| Go to definition | Values, type names, members, enum entries |
| Find references / rename | Including members and `obj["field"]` forms |
| Document symbols / outline | Classes, functions, variables, types |
| Snippets | `class`, `interface`, `enum`, typed functions, loops, macros, `import`, `defer` … |

## Requirements

The extension needs the `tlua` language server. Resolution order:

1. **`typelua.server.path`** setting — explicit path to the executable;
2. **bundled server** — `server/tlua-<platform>-<arch>[.exe]` inside the
   extension (see `server/README.md`);
3. **`tlua` on `PATH`** (with `typelua.server.args`, default `["lsp"]`).

Build it from the TypeLua repo with `go build -o tlua ./cmd/tlua` and put
it on `PATH`. If no server is found you get an error message with a button
that opens the right setting.

## Extension Settings

- `typelua.server.path`: server executable path (empty = bundled, else PATH).
- `typelua.server.args`: server arguments (default `["lsp"]`).
- `typelua.trace.server`: `off` | `messages` | `verbose` protocol tracing.
- `typelua.server.maxRestarts`: auto-restart budget after crashes (default 3/min).
- `typelua.server.startTimeout`: ms to wait for server readiness before a
  warning popup (default 10000, 0 disables).

## Commands

- `TypeLua: Restart Language Server`
- `TypeLua: Show Language Server Output`

## Notes

- The server analyzes one file at a time; cross-file `require`/`import`
  targets resolve when they are part of the same `tlua.json` project.
- Diagnostics use the same codes as `tlua check`, so CLI and editor agree.

## Troubleshooting

**Nothing happens when I open a `.tl` file** — check, in order:

1. The extension is installed: Extensions view → TypeLua → version shown.
   After installing a `.vsix`, run *Developer: Reload Window*.
2. The file's language mode (bottom-right corner) says **TypeLua**.
   If it says something else, click it and pick TypeLua.
3. The status bar shows a TypeLua item once a `.tl` file is open or the
   folder contains `.tl` files.

**No diagnostics / hover / go-to-definition** — the language server is not
running:

1. Open *Output → TypeLua Language Server* and look for errors.
2. GUI-launched VS Code often has a minimal `PATH`. Either put `tlua` on
   `PATH` for GUI apps, or set the absolute path in
   `typelua.server.path` (e.g. `/home/user/tools/tlua`), then run
   *TypeLua: Restart Language Server*.
3. Verify the server itself works: `tlua lsp` must start and wait on stdin.

**Go to definition needs a gesture**: `Ctrl+Click` (or `F12`) on the symbol.
Plain click only moves the cursor.

## Release Notes

See [CHANGELOG.md](CHANGELOG.md).
