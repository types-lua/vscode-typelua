// Bundle the extension (including vscode-languageclient) into a single file.
// Packaging then needs no node_modules at runtime, which removes the whole
// class of "dependency missing from the VSIX" activation bugs.
import { build } from 'esbuild';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)));

await build({
  entryPoints: [path.join(root, 'src', 'extension.ts')],
  outfile: path.join(root, 'dist', 'extension.js'),
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node20',
  sourcemap: true,
  // Provided by the VS Code host at runtime.
  external: ['vscode'],
  logLevel: 'info',
});
