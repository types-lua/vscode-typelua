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

  const mainRel = (pkg.main || '').replace(/^\.\//, '');
  ok(mainRel.length > 0 && fs.existsSync(path.join(ROOT, mainRel)), `entrypoint exists: ${mainRel}`);

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

  console.log(`  PASS (${passed} assertions)`);
}

module.exports = main;
if (require.main === module) {
  main().catch((e) => {
    console.error('  FAIL:', e.message);
    process.exit(1);
  });
}
