// Package the extension as a VSIX and verify the archive contents.
//
// `dist/extension.js` is a self-contained esbuild bundle, so node_modules is
// intentionally excluded. Packaging with --no-dependencies is therefore both
// correct and fast; the archive checks below make sure a bad ignore rule or a
// stale bundle cannot slip through.
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { builtinModules } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));

function fail(message) {
  console.error(`package: ${message}`);
  process.exit(1);
}

if (!existsSync(path.join(root, 'dist', 'extension.js'))) {
  fail('dist/extension.js is missing; run "npm run bundle" first');
}
const bundleBytes = readFileSync(path.join(root, 'dist', 'extension.js')).length;
if (bundleBytes < 100_000) {
  fail(`bundle looks too small (${bundleBytes} bytes); dependencies were probably not bundled`);
}

const vsce = path.join(
  root,
  'node_modules',
  '.bin',
  process.platform === 'win32' ? 'vsce.cmd' : 'vsce',
);
if (!existsSync(vsce)) fail('vsce is not installed; run "npm ci" first');

const out = path.join(root, `typelua-${pkg.version}.vsix`);
rmSync(out, { force: true });
execFileSync(vsce, ['package', '--no-dependencies', '--out', out], {
  cwd: root,
  stdio: 'inherit',
});

// `unzip -Z1` prints one archive member per line, which is exact and stable
// (the human-readable listing pads columns and breaks naive matching).
const names = execFileSync('unzip', ['-Z1', out], { encoding: 'utf8' })
  .split('\n')
  .map((line) => line.trim())
  .filter(Boolean);
const members = new Set(names);
for (const required of [
  'extension/package.json',
  'extension/dist/extension.js',
  'extension/README.md',
  'extension/CHANGELOG.md',
  'extension/syntaxes/typelua.tmGrammar.json',
  'extension/snippets/typelua.json',
]) {
  if (!members.has(required)) fail(`packaged VSIX is missing ${required}`);
}
for (const name of names) {
  if (name.startsWith('extension/node_modules/')) {
    fail(`packaged VSIX contains ${name}; the bundle should be self-contained`);
  }
}

// Extract the archived bundle once; all verification below runs on exactly
// what will be published, not on the working tree.
const archived = execFileSync('unzip', ['-p', out, 'extension/dist/extension.js'], {
  encoding: 'utf8',
  maxBuffer: 16 * 1024 * 1024,
});
const built = readFileSync(path.join(root, 'dist', 'extension.js'), 'utf8');
if (archived !== built) {
  fail('archived bundle does not match dist/extension.js (stale package?)');
}

// Never publish credentials or stray local files, even if .vscodeignore drifts.
for (const name of names) {
  if (/(^|\/)(\.env|\.npmrc|id_rsa)(\/|$)|\/([^/]*\.(pem|key|p12))$/.test(name)) {
    fail(`refusing to publish sensitive file: ${name}`);
  }
}

// Every literal require() in the archive must be the host `vscode` module or a
// Node builtin. A third-party name means something was left unbundled and the
// VSIX would fail at runtime with MODULE_NOT_FOUND.
const builtins = new Set(builtinModules);
const requiredModules = new Set();
for (const match of archived.matchAll(/\brequire\(\s*["']([^"']+)["']\s*\)/g)) {
  requiredModules.add(match[1]);
}
for (const name of requiredModules) {
  if (name === 'vscode' || builtins.has(name) || builtins.has(name.replace(/^node:/, ''))) {
    continue;
  }
  fail(`bundle requires "${name}", which is not bundled and not a Node builtin`);
}

// Activation smoke test on the *archived* bundle: extract it, generate a stub
// `vscode` host module (base classes are discovered from the bundle itself),
// and require it. This catches broken imports and syntax errors that a file
// listing alone cannot see.
const smokeDir = mkdtempSync(path.join(os.tmpdir(), 'typelua-vsix-smoke-'));
try {
  const entry = path.join(smokeDir, 'extension.js');
  writeFileSync(entry, archived);
  const stubDir = path.join(smokeDir, 'node_modules', 'vscode');
  mkdirSync(stubDir, { recursive: true });

  // vscode-languageclient subclasses host classes at module load time; derive
  // them from `extends ns.Name` so the stub stays correct as the client grows.
  const baseNames = new Set();
  for (const match of archived.matchAll(/extends\s+[\w$]+\s*\.\s*([A-Za-z_$][\w$]*)/g)) {
    baseNames.add(match[1]);
  }
  const stub = [
    'const out = {};',
    `for (const name of ${JSON.stringify([...baseNames])}) out[name] = class {};`,
    'module.exports = out;',
    '',
  ].join('\n');
  writeFileSync(path.join(stubDir, 'index.js'), stub);

  const probe = path.join(smokeDir, 'probe.js');
  writeFileSync(
    probe,
    "const m = require(process.argv[2]);\n" +
      "if (typeof m.activate !== 'function') { throw new Error('activate is not exported'); }\n" +
      "if (typeof m.deactivate !== 'function') { throw new Error('deactivate is not exported'); }\n",
  );
  execFileSync(process.execPath, [probe, entry], { cwd: smokeDir, stdio: 'inherit' });
} finally {
  rmSync(smokeDir, { recursive: true, force: true });
}

console.log(`package: wrote ${out}`);
console.log(`package: verified bundle (${bundleBytes} bytes) and archive layout`);
console.log(`package: bundle requires only builtins (${[...requiredModules].sort().join(', ')})`);
