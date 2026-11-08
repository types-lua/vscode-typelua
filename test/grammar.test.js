'use strict';
// TextMate grammar tests: structural checks + real tokenization of a
// sample document and every examples/**/*.tl file in the TypeLua repo.
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const GRAMMAR_PATH = path.join(ROOT, 'syntaxes', 'typelua.tmGrammar.json');
const EXAMPLES_DIR =
  process.env.TYPELUA_EXAMPLES || path.join(ROOT, '..', 'TypeLua', 'examples');

let passed = 0;
function ok(cond, msg) {
  if (!cond) {
    throw new Error('ASSERT: ' + msg);
  }
  passed++;
}

async function loadGrammar() {
  const raw = fs.readFileSync(GRAMMAR_PATH, 'utf8');
  const grammarDef = JSON.parse(raw); // throws on invalid JSON
  ok(grammarDef.scopeName === 'source.tlua', 'scopeName is source.tlua');
  ok(Array.isArray(grammarDef.patterns) && grammarDef.patterns.length > 0, 'has patterns');

  // Every #include must resolve to a repository rule.
  const repo = grammarDef.repository || {};
  const check = (patterns) => {
    for (const p of patterns || []) {
      if (p.include && p.include.startsWith('#')) {
        ok(repo[p.include.slice(1)], `repository has ${p.include}`);
      }
      check(p.patterns);
    }
  };
  check(grammarDef.patterns);
  for (const key of Object.keys(repo)) {
    check(repo[key].patterns);
  }

  const onig = require('vscode-oniguruma');
  const wasmPath = require.resolve('vscode-oniguruma/release/onig.wasm');
  const wasmBin = fs.readFileSync(wasmPath);
  await onig.loadWASM(
    wasmBin.buffer.slice(wasmBin.byteOffset, wasmBin.byteOffset + wasmBin.byteLength),
  );
  const { Registry } = require('vscode-textmate');
  const registry = new Registry({
    onigLib: Promise.resolve({
      createOnigScanner: (sources) => new onig.OnigScanner(sources),
      createOnigString: (str) => new onig.OnigString(str),
    }),
    loadGrammar: async () => grammarDef,
  });
  const grammar = await registry.loadGrammar('source.tlua');
  ok(grammar, 'grammar loads in vscode-textmate');
  return grammar;
}

// Tokenize a single line; returns [{text, scopes}].
function tokenizeLineTokens(grammar, line) {
  const out = [];
  let rule = null;
  const lr = grammar.tokenizeLine(line, rule);
  for (const t of lr.tokens) {
    out.push({ text: line.slice(t.startIndex, t.endIndex), scopes: t.scopes });
  }
  return out;
}

function scopesOf(tokens, substr, occurrence = 0) {
  let seen = 0;
  for (const t of tokens) {
    if (t.text === substr || t.text.includes(substr)) {
      if (seen === occurrence) {
        return t.scopes;
      }
      seen++;
    }
  }
  return null;
}

async function testSample(grammar) {
  const lines = [
    '-- line comment',
    '--[[ block comment ]]',
    'local x: number = 1',
    'local s = "hi \\n"',
    "local q = 'lit'",
    'local t = [[long]]',
    'local h = 0xFF',
    'local f = 3.14',
    'class Dog extends Animal {',
    'interface Named { name: string }',
    'enum Color { Red = "red" }',
    'type Point = { x: number }',
    'local function foo(a: number): string return a end',
    'macro twice(x) = (x) + (x)',
    'd:speak("woof")',
    'local c <const> = 1',
    '::done:: goto done',
    'local p: Point = { x = 1 }',
    'local v = t.field',
    'if x ~= nil then print(x) end',
  ];
  let rule = null;
  for (const line of lines) {
    const lr = grammar.tokenizeLine(line, rule); // must not throw
    rule = lr.ruleStack;
    ok(Array.isArray(lr.tokens) && lr.tokens.length > 0, `tokens for: ${line}`);
  }

  const t = (line) => tokenizeLineTokens(grammar, line);
  ok(scopesOf(t('-- line comment'), '-- line comment').includes('comment.line.double-dash.tlua'), 'line comment scope');
  ok(scopesOf(t('--[[ block comment ]]'), '--[[').includes('punctuation.definition.comment.begin.tlua'), 'block comment begin');
  ok(scopesOf(t('local x: number = 1'), 'local').includes('keyword.control.tlua'), 'local keyword');
  ok(scopesOf(t('local x: number = 1'), 'number').includes('storage.type.primitive.tlua'), 'primitive type');
  ok(scopesOf(t('local x: number = 1'), '1').includes('constant.numeric.decimal.tlua'), 'decimal number');
  ok(scopesOf(t('local s = "hi \\n"'), 'hi ').includes('string.quoted.double.tlua'), 'double string');
  ok(scopesOf(t('local s = "hi \\n"'), '\\n').includes('constant.character.escape.tlua'), 'string escape');
  ok(scopesOf(t("local q = 'lit'"), 'lit').includes('string.quoted.single.tlua'), 'single string');
  ok(scopesOf(t('local t = [[long]]'), 'long').includes('string.quoted.other.long.tlua'), 'long string');
  ok(scopesOf(t('local t = [[long]]'), '[[').includes('punctuation.definition.string.begin.tlua'), 'long string begin');
  ok(scopesOf(t('local h = 0xFF'), '0xFF').includes('constant.numeric.hex.tlua'), 'hex number');
  ok(scopesOf(t('class Dog extends Animal {'), 'class').includes('storage.type.tlua'), 'class keyword');
  ok(scopesOf(t('class Dog extends Animal {'), 'Dog').includes('entity.name.class.tlua'), 'class name');
  ok(scopesOf(t('class Dog extends Animal {'), 'extends').includes('storage.type.tlua'), 'extends keyword');
  ok(scopesOf(t('interface Named { name: string }'), 'Named').includes('entity.name.type.tlua'), 'interface name');
  ok(scopesOf(t('enum Color { Red = "red" }'), 'Color').includes('entity.name.type.tlua'), 'enum name');
  ok(scopesOf(t('type Point = { x: number }'), 'Point').includes('entity.name.type.tlua'), 'type alias name');
  ok(scopesOf(t('local function foo(a: number): string return a end'), 'foo').includes('entity.name.function.tlua'), 'function name');
  ok(scopesOf(t('macro twice(x) = (x) + (x)'), 'twice').includes('entity.name.function.macro.tlua'), 'macro name');
  ok(scopesOf(t('d:speak("woof")'), 'speak').includes('entity.name.function.method.tlua'), 'method call');
  ok(scopesOf(t('local c <const> = 1'), 'const').includes('storage.modifier.attribute.tlua'), 'const attribute');
  ok(scopesOf(t('::done:: goto done'), 'done').includes('entity.name.label.tlua'), 'label name');
  ok(scopesOf(t('::done:: goto done'), 'goto').includes('keyword.control.tlua'), 'goto keyword');
  ok(scopesOf(t('local p: Point = { x = 1 }'), 'Point').includes('entity.name.type.tlua'), 'capitalized type use');
  ok(scopesOf(t('local p: Point = { x = 1 }'), 'x').includes('variable.other.property.tlua'), 'table key');
  ok(scopesOf(t('if x ~= nil then print(x) end'), 'nil').includes('constant.language.tlua'), 'nil constant');
  ok(scopesOf(t('if x ~= nil then print(x) end'), 'print').includes('support.function.builtin.tlua'), 'builtin print');
  ok(scopesOf(t('async function work(): void end'), 'async').includes('keyword.control.tlua'), 'async keyword');
  ok(scopesOf(t('await jobs:send(1)'), 'await').includes('keyword.control.tlua'), 'await keyword');
  ok(scopesOf(t('defer cleanup()'), 'defer').includes('keyword.control.tlua'), 'defer keyword');
  ok(scopesOf(t('select { case local v = ch:recv() then print(v) }'), 'select').includes('keyword.control.tlua'), 'select keyword');
  ok(scopesOf(t('local ch: chan<number> = makeChan<number>(1)'), 'chan').includes('storage.type.tlua'), 'chan type');
  ok(scopesOf(t('local f: (number) -> string'), '->').includes('keyword.operator.arrow.tlua'), 'arrow operator');
  ok(scopesOf(t('import codec from "./codec"'), 'import').includes('keyword.control.tlua'), 'import keyword');
}

function listTlFiles(dir) {
  const out = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) {
        walk(p);
      } else if (e.isFile() && p.endsWith('.tl')) {
        out.push(p);
      }
    }
  };
  walk(dir);
  return out;
}

async function testCorpus(grammar) {
  if (!fs.existsSync(EXAMPLES_DIR)) {
    console.log(`  corpus skipped (no examples at ${EXAMPLES_DIR})`);
    return;
  }
  const files = listTlFiles(EXAMPLES_DIR);
  ok(files.length > 10, `corpus has files (got ${files.length})`);
  let totalLines = 0;
  for (const f of files) {
    const src = fs.readFileSync(f, 'utf8');
    let rule = null;
    for (const line of src.split('\n')) {
      const lr = grammar.tokenizeLine(line, rule); // must not throw
      rule = lr.ruleStack;
      ok(lr.tokens.length > 0 || line.length === 0, `line tokenized in ${f}`);
      totalLines++;
    }
  }
  console.log(`  corpus: ${files.length} files, ${totalLines} lines tokenized`);
}

async function main() {
  console.log('grammar tests');
  const grammar = await loadGrammar();
  await testSample(grammar);
  await testCorpus(grammar);
  console.log(`  PASS (${passed} assertions)`);
}

module.exports = main;
if (require.main === module) {
  main().catch((e) => {
    console.error('  FAIL:', e.message);
    process.exit(1);
  });
}
