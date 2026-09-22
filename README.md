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

## Commands

- `TypeLua: Restart Language Server`
- `TypeLua: Show Language Server Output`

## Notes

- The server analyzes one file at a time; cross-file `require`/`import`
  targets resolve when they are part of the same `tlua.json` project.
- Diagnostics use the same codes as `tlua check`, so CLI and editor agree.

## Release Notes

See [CHANGELOG.md](CHANGELOG.md).
