# Bundled language servers (optional)
#
# The extension looks here second (after the `typelua.server.path` setting,
# before PATH) for a server binary named:
#
#   server/tlua-<platform>-<arch>[.exe]
#
# Examples:
#   server/tlua-linux-x64
#   server/tlua-linux-arm64
#   server/tlua-linux-riscv64
#   server/tlua-darwin-arm64
#   server/tlua-win32-x64.exe
#
# Build one from the TypeLua repo, e.g.:
#   go build -o tlua-linux-x64 ./cmd/tlua
#   GOOS=windows GOARCH=amd64 go build -o tlua-win32-x64.exe ./cmd/tlua
#
# Platform-specific packaging (one .vsix per platform) can drop the right
# binary here so the extension works with zero configuration.
