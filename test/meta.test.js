'use strict';
// Extension manifest consistency: activation, contributed files, commands.
// Catches packaging bugs (e.g. a .vscodeignore that drops the entrypoint).
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');

let passed = 0;
function ok(cond, msg) {
  if (!cond) {
    throw new Error('ASSERT: ' + msg);
  }
  passed++;
}

async function main() {
  console.log('extension manifest tests');
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));

  ok(
    Array.isArray(pkg.activationEvents) &&
      pkg.activationEvents.includes('onLanguage:typelua'),
    'activates on typelua language',
  );
  ok(
    pkg.activationEvents.some((e) => e.startsWith('workspaceContains:')),
    'has workspace fallback activation',
  );
  ok(pkg.activationEvents.includes('onStartupFinished'), 'activates for the Test Explorer');
  ok(pkg.activationEvents.includes('onDebugResolve:typelua'), 'activates for debugging');

  const debuggers = pkg.contributes.debuggers || [];
  ok(debuggers.length === 1 && debuggers[0].type === 'typelua', 'contributes a typelua debugger');
  const launch = debuggers[0].configurationAttributes.launch;
  ok(Array.isArray(launch.required) && launch.required.includes('program'), 'launch requires program');
  ok(launch.properties.stopOnEntry && launch.properties.stopOnEntry.type === 'boolean', 'stopOnEntry supported');
  ok(Array.isArray(debuggers[0].initialConfigurations) && debuggers[0].initialConfigurations.length > 0, 'debugger has initial configuration');

  const menu = pkg.contributes.menus || {};
  const editorCommands = (menu['editor/context'] || []).map((m) => m.command);
  ok(editorCommands.includes('typelua.runFile'), 'context menu runs files');
  ok(editorCommands.includes('typelua.debugFile'), 'context menu debugs files');

  // The shipped entrypoint is the esbuild bundle, produced by `npm run
  // bundle`; it is intentionally absent from a fresh checkout and from git.
  ok(pkg.main === './dist/extension.js', 'main points at the esbuild bundle');

  const lang = pkg.contributes.languages[0];
  ok(lang.id === 'typelua', 'language id is typelua');
  ok(lang.extensions.includes('.tl'), '.tl associated');

  const cfgRel = lang.configuration.replace(/^\.\//, '');
  const lc = JSON.parse(fs.readFileSync(path.join(ROOT, cfgRel), 'utf8'));
  ok(lc.comments.lineComment === '--', 'language configuration loads');

  for (const g of pkg.contributes.grammars) {
    const p = path.join(ROOT, g.path.replace(/^\.\//, ''));
    const gram = JSON.parse(fs.readFileSync(p, 'utf8'));
    ok(gram.scopeName === 'source.tlua', 'grammar scope matches');
  }

  for (const s of pkg.contributes.snippets) {
    const p = path.join(ROOT, s.path.replace(/^\.\//, ''));
    const snips = JSON.parse(fs.readFileSync(p, 'utf8'));
    ok(Object.keys(snips).length > 0, 'snippets load');
    for (const [name, s] of Object.entries(snips)) {
      ok(s.prefix && s.body && s.description, `snippet complete: ${name}`);
    }
  }

  // Every contributed command must be registered by the client.
  const src = fs.readFileSync(path.join(ROOT, 'src', 'extension.ts'), 'utf8');
  for (const c of pkg.contributes.commands) {
    ok(src.includes(`'${c.command}'`), `command registered: ${c.command}`);
  }

  // Every configuration property must be read by the client.
  for (const key of Object.keys(pkg.contributes.configuration.properties)) {
    const leaf = key.split('.').slice(1).join('.');
    ok(src.includes(leaf), `setting consumed: ${key}`);
  }

  // The bundle is self-contained, so runtime dependencies must stay empty and
  // node_modules must be excluded; the packaging script additionally verifies
  // the archive. These checks catch the historical activation failure
  // (MODULE_NOT_FOUND) at `npm test` time instead of after publishing.
  const runtimeDeps = Object.keys(pkg.dependencies || {});
  ok(runtimeDeps.length === 0, 'no runtime dependencies (bundle is self-contained)');
  ok(Boolean(pkg.scripts?.bundle), 'has a bundle script');
  ok(Boolean(pkg.devDependencies?.esbuild), 'esbuild is a dev dependency');
  ok(
    Boolean(pkg.devDependencies?.['vscode-languageclient']),
    'vscode-languageclient is bundled from devDependencies',
  );

  const ignore = fs.readFileSync(path.join(ROOT, '.vscodeignore'), 'utf8')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'));
  ok(ignore.includes('node_modules/**'), 'packaging excludes node_modules');
  ok(!ignore.some((l) => l.replace(/\/$/, '') === 'dist'), 'packaging keeps dist/');

  const buildScript = fs.readFileSync(path.join(ROOT, 'scripts', 'build.mjs'), 'utf8');
  ok(buildScript.includes("external: ['vscode']"), 'vscode stays external in the bundle');

  const packScript = fs.readFileSync(path.join(ROOT, 'scripts', 'package.mjs'), 'utf8');
  ok(packScript.includes('extension/dist/extension.js'), 'packaging verifies the bundle member');
  ok(packScript.includes('extension/node_modules/'), 'packaging verifies node_modules is absent');

  console.log(`  PASS (${passed} assertions)`);
}

module.exports = main;
if (require.main === module) {
  main().catch((e) => {
    console.error('  FAIL:', e.message);
    process.exit(1);
  });
}
