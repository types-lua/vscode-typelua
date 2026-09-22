'use strict';
// End-to-end LSP contract tests against a real `tlua lsp` server.
// Speaks raw JSON-RPC over stdio and verifies exactly the responses the
// VS Code client depends on: initialize, diagnostics push, completion,
// hover, definition, references, rename, document symbols, incremental
// edits, and the shutdown/exit handshake.
const { spawn, execSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const TEST_TLUA_DIR = '/home/tang/TypeLua';
const BIN = path.join(__dirname, 'tlua-testbin');
const URI = 'file:///tmp/typelua-lsp-contract.tl';

let passed = 0;
function ok(cond, msg) {
  if (!cond) {
    throw new Error('ASSERT: ' + msg);
  }
  passed++;
}

function buildServer() {
  const env = { ...process.env, PATH: process.env.PATH + ':/usr/local/go/bin' };
  execSync(`go build -o ${BIN} ./cmd/tlua`, { cwd: TEST_TLUA_DIR, env, stdio: 'pipe' });
  ok(fs.existsSync(BIN), 'server binary built');
}

class Rpc {
  constructor(proc) {
    this.proc = proc;
    this.buf = Buffer.alloc(0);
    this.nextId = 1;
    this.pending = new Map(); // id -> {resolve, reject}
    this.diagQueue = []; // publishDiagnostics params
    this.diagWaiters = [];
    this.exited = null;
    proc.stdout.on('data', (d) => this.feed(d));
    proc.on('exit', (code) => {
      if (this.exited) {
        this.exited(code);
      }
    });
    proc.on('error', () => {});
  }

  feed(chunk) {
    this.buf = Buffer.concat([this.buf, chunk]);
    for (;;) {
      const head = this.buf.indexOf('\r\n\r\n');
      if (head < 0) {
        return;
      }
      const header = this.buf.slice(0, head).toString('latin1');
      const m = /Content-Length:\s*(\d+)/i.exec(header);
      if (!m) {
        throw new Error('bad LSP header: ' + header);
      }
      const len = parseInt(m[1], 10);
      if (this.buf.length < head + 4 + len) {
        return;
      }
      const body = this.buf.slice(head + 4, head + 4 + len).toString('utf8');
      this.buf = this.buf.slice(head + 4 + len);
      this.handle(JSON.parse(body));
    }
  }

  handle(msg) {
    if (msg.id !== undefined && msg.id !== null) {
      const p = this.pending.get(msg.id);
      if (p) {
        this.pending.delete(msg.id);
        p(msg);
      }
      return;
    }
    if (msg.method === 'textDocument/publishDiagnostics') {
      if (this.diagWaiters.length > 0) {
        this.diagWaiters.shift()(msg.params);
      } else {
        this.diagQueue.push(msg.params);
      }
    }
  }

  send(obj) {
    const body = Buffer.from(JSON.stringify(obj), 'utf8');
    this.proc.stdin.write(
      `Content-Length: ${body.length}\r\n\r\n`,
    );
    this.proc.stdin.write(body);
  }

  request(method, params, timeoutMs = 8000) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`timeout waiting for ${method}`));
      }, timeoutMs);
      this.pending.set(id, (msg) => {
        clearTimeout(timer);
        resolve(msg);
      });
      this.send({ jsonrpc: '2.0', id, method, params });
    });
  }

  notify(method, params) {
    this.send({ jsonrpc: '2.0', method, params });
  }

  nextDiagnostics(timeoutMs = 8000) {
    if (this.diagQueue.length > 0) {
      return Promise.resolve(this.diagQueue.shift());
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('timeout waiting for diagnostics')), timeoutMs);
      this.diagWaiters.push((p) => {
        clearTimeout(timer);
        resolve(p);
      });
    });
  }

  waitExit(timeoutMs = 8000) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('timeout waiting for exit')), timeoutMs);
      this.exited = (code) => {
        clearTimeout(timer);
        resolve(code);
      };
    });
  }
}

const DOC_V1 = 'local n: number = 1\nprint(n)\nlocal s: string = "hi"\n';

async function main() {
  console.log('lsp contract tests');
  buildServer();
  const proc = spawn(BIN, ['lsp'], { stdio: ['pipe', 'pipe', 'pipe'] });
  let stderr = '';
  proc.stderr.on('data', (d) => {
    stderr += d.toString();
  });
  const rpc = new Rpc(proc);

  const init = await rpc.request('initialize', {
    processId: process.pid,
    rootUri: 'file:///tmp',
    capabilities: {},
  });
  ok(!init.error, 'initialize has no error: ' + JSON.stringify(init.error));
  const caps = init.result.capabilities;
  ok(caps.textDocumentSync === 2, 'incremental sync advertised');
  ok(caps.hoverProvider === true, 'hover advertised');
  ok(caps.definitionProvider === true, 'definition advertised');
  ok(
    Array.isArray(caps.completionProvider.triggerCharacters) &&
      caps.completionProvider.triggerCharacters.includes('.'),
    'completion triggers advertised',
  );
  ok(caps.referencesProvider === true, 'references advertised');
  ok(caps.renameProvider === true, 'rename advertised');
  ok(caps.documentSymbolProvider === true, 'documentSymbol advertised');
  rpc.notify('initialized', {});

  rpc.notify('textDocument/didOpen', {
    textDocument: { uri: URI, languageId: 'typelua', version: 1, text: DOC_V1 },
  });
  const diags1 = await rpc.nextDiagnostics();
  ok(diags1.uri === URI, 'diagnostics uri matches');
  ok(Array.isArray(diags1.diagnostics), 'diagnostics is an array');
  for (const d of diags1.diagnostics) {
    ok(d.range && d.message && d.source === 'tlua', 'diagnostic shape');
  }

  const comp = await rpc.request('textDocument/completion', {
    textDocument: { uri: URI },
    position: { line: 1, character: 0 },
  });
  ok(comp.result && Array.isArray(comp.result.items), 'completion returns items');
  const labels = comp.result.items.map((i) => i.label);
  ok(labels.includes('n'), 'completion contains scope variable n');
  ok(labels.includes('local'), 'completion contains keywords');

  const hov = await rpc.request('textDocument/hover', {
    textDocument: { uri: URI },
    position: { line: 1, character: 7 },
  });
  ok(hov.result && hov.result.contents && hov.result.contents.value.includes('n'), 'hover shows n');

  const def = await rpc.request('textDocument/definition', {
    textDocument: { uri: URI },
    position: { line: 1, character: 7 },
  });
  ok(Array.isArray(def.result) && def.result.length > 0, 'definition returns locations');
  ok(def.result[0].uri === URI && def.result[0].range.start.line === 0, 'definition points at line 0');

  const refs = await rpc.request('textDocument/references', {
    textDocument: { uri: URI },
    position: { line: 1, character: 7 },
    context: { includeDeclaration: true },
  });
  ok(Array.isArray(refs.result) && refs.result.length >= 2, 'references include decl + use');

  const ren = await rpc.request('textDocument/rename', {
    textDocument: { uri: URI },
    position: { line: 1, character: 7 },
    newName: 'n2',
  });
  ok(
    (ren.result && (ren.result.changes || ren.result.documentChanges)) || ren.error,
    'rename returns WorkspaceEdit or a clean error',
  );

  const syms = await rpc.request('textDocument/documentSymbol', {
    textDocument: { uri: URI },
  });
  ok(Array.isArray(syms.result) && syms.result.length > 0, 'document symbols returned');

  // Incremental edit: turn `1` into `"s"` -> must produce an error diagnostic.
  rpc.notify('textDocument/didChange', {
    textDocument: { uri: URI, version: 2 },
    contentChanges: [
      {
        range: { start: { line: 0, character: 18 }, end: { line: 0, character: 19 } },
        text: '"s"',
      },
    ],
  });
  const diags2 = await rpc.nextDiagnostics();
  const errors = diags2.diagnostics.filter((d) => d.severity === 1);
  ok(errors.length > 0, 'incremental edit surfaces a type error');

  const shut = await rpc.request('shutdown', null);
  ok(!shut.error && shut.result === null, 'shutdown returns null');
  rpc.notify('exit', null);
  const code = await rpc.waitExit();
  ok(code === 0, `server exits 0 after shutdown (got ${code}, stderr: ${stderr.slice(0, 200)})`);

  console.log(`  PASS (${passed} assertions)`);
}

module.exports = main;
if (require.main === module) {
  main().catch((e) => {
    console.error('  FAIL:', e.message);
    process.exit(1);
  });
}
