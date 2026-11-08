'use strict';
// Client notification behavior tests with mocked `vscode` and
// `vscode-languageclient/node`. Drives the real compiled extension through:
// missing server, startup watchdog timeout, unexpected close (throttled),
// and crash-budget exhaustion.
const Module = require('module');
const path = require('path');

const EXT_JS = path.join(__dirname, '..', 'out', 'extension.js');

let passed = 0;
function ok(cond, msg) {
  if (!cond) {
    throw new Error('ASSERT: ' + msg);
  }
  passed++;
}

// ---------- mocks ----------
function makeVscode(configValues) {
  const calls = { errors: [], warnings: [], infos: [] };
  const dismiss = Promise.resolve(undefined);
  const statusBar = { text: '', tooltip: '', backgroundColor: undefined, command: '', shown: false, show() { this.shown = true; } };
  const outputLines = [];
  const disposable = { dispose: () => {} };
  const emptyChildren = {
    size: 0,
    replace() {},
    get() { return undefined; },
    *[Symbol.iterator]() {},
  };
  const controller = {
    items: { replace() {}, forEach() {} },
    createTestItem: (id, label, uri) => ({ id, label, uri, children: emptyChildren }),
    createRunProfile: () => disposable,
    createTestRun: () => ({
      started() {}, passed() {}, failed() {}, errored() {}, skipped() {}, end() {},
    }),
    refreshHandler: undefined,
    dispose: () => {},
  };
  const run = {
    started() {}, passed() {}, failed() {}, errored() {}, skipped() {}, end() {},
  };
  const uri = (p) => ({ fsPath: p, scheme: 'file', path: p, toString: () => 'file://' + p });
  const vscode = {
    StatusBarAlignment: { Right: 1 },
    ThemeColor: class ThemeColor { constructor(id) { this.id = id; } },
    window: {
      createOutputChannel: () => ({
        appendLine: (s) => outputLines.push(s),
        show: () => {},
        dispose: () => {},
      }),
      createStatusBarItem: () => statusBar,
      showErrorMessage: (msg) => { calls.errors.push(String(msg)); return dismiss; },
      showWarningMessage: (msg) => { calls.warnings.push(String(msg)); return dismiss; },
      showInformationMessage: (msg) => { calls.infos.push(String(msg)); return dismiss; },
      showQuickPick: async () => undefined,
    },
    workspace: {
      getConfiguration: () => ({ get: (k) => configValues[k] }),
      onDidChangeConfiguration: () => disposable,
      workspaceFolders: [],
      getWorkspaceFolder: () => undefined,
      createFileSystemWatcher: () => ({
        onDidCreate: () => disposable,
        onDidChange: () => disposable,
        onDidDelete: () => disposable,
        dispose: () => {},
      }),
      textDocuments: [],
    },
    debug: {
      registerDebugAdapterDescriptorFactory: () => disposable,
      registerDebugConfigurationProvider: () => disposable,
      registerDebugAdapterTrackerFactory: () => disposable,
      onDidStartDebugSession: () => disposable,
      onDidTerminateDebugSession: () => disposable,
      startDebugging: async () => true,
    },
    tests: {
      createTestController: () => controller,
    },
    tasks: {
      Task: class Task {},
      ShellExecution: class ShellExecution {},
      TaskScope: { Workspace: 1 },
      TaskRevealKind: { Always: 1, Silent: 2 },
      TaskPanelKind: { Dedicated: 1 },
      executeTask: async () => ({ terminate() {} }),
    },
    Uri: { file: uri },
    TestRunProfileKind: { Run: 1, Debug: 2, Coverage: 3 },
    TestMessage: class TestMessage { constructor(message) { this.message = message; } },
    commands: {
      registered: {},
      registerCommand: (id, fn) => { vscode.commands.registered[id] = fn; return { dispose: () => {} }; },
      executeCommand: async () => {},
    },
    Disposable: class {},
  };
  return { vscode, calls, statusBar, outputLines };
}

const State = { Stopped: 1, Starting: 2, Running: 3 };
let lastClientOptions = null;
let stateListeners = [];
class MockLanguageClient {
  constructor(id, name, serverOptions, clientOptions) {
    this.serverOptions = serverOptions;
    this.clientOptions = clientOptions;
    lastClientOptions = clientOptions;
    this._state = State.Starting;
    this.startCalled = false;
  }
  get state() { return this._state; }
  onDidChangeState(fn) { stateListeners.push(fn); return { dispose: () => {} }; }
  async start() { this.startCalled = true; }
  async stop() { this._state = State.Stopped; }
  async setTrace() {}
  emit(state) {
    this._state = state;
    for (const fn of stateListeners) fn({ newState: state, oldState: 0 });
  }
}
const lcMock = {
  State,
  TransportKind: { stdio: 0 },
  RevealOutputChannelOn: { Never: 0 },
  Trace: { Off: 0, Messages: 1, Verbose: 2 },
  ErrorAction: { Continue: 1, Shutdown: 2 },
  CloseAction: { DoNotRestart: 1, Restart: 2 },
  LanguageClient: MockLanguageClient,
};

function loadExtension(mockVscode) {
  delete require.cache[EXT_JS];
  lastClientOptions = null;
  stateListeners = [];
  const origLoad = Module._load;
  Module._load = function (request, parent, isMain) {
    if (request === 'vscode') return mockVscode;
    if (request === 'vscode-languageclient/node') return lcMock;
    return origLoad.call(this, request, parent, isMain);
  };
  try {
    return require(EXT_JS);
  } finally {
    Module._load = origLoad;
  }
}

const fakeContext = () => ({ extensionPath: '/fake/ext', subscriptions: [] });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function scenarioMissingServer() {
  const { vscode, calls, statusBar } = makeVscode({
    'server.path': '/nonexistent/tlua-xyz',
    'server.args': ['lsp'],
    'server.maxRestarts': 3,
    'trace.server': 'off',
    'server.startTimeout': 10000,
  });
  const ext = loadExtension(vscode);
  await ext.activate(fakeContext());
  ok(calls.errors.length === 1, 'missing server shows one error popup');
  ok(/unavailable/.test(calls.errors[0]), 'popup says features unavailable');
  ok(statusBar.backgroundColor !== undefined, 'status bar marked as error');
  await ext.deactivate();
}

async function scenarioWatchdogDeterministic() {
  // Use a bogus-but-existing executable path? Instead: point at node itself
  // (exists, spawns, never speaks LSP) with a bogus arg so it exits fast...
  // Simplest deterministic watchdog: settings path = /bin/sleep with args
  // that keep it alive without LSP (sleep 5). Client starts, never Running.
  const { vscode, calls } = makeVscode({
    'server.path': '/bin/sleep',
    'server.args': ['5'],
    'server.maxRestarts': 3,
    'trace.server': 'off',
    'server.startTimeout': 1000,
  });
  const ext = loadExtension(vscode);
  await ext.activate(fakeContext());
  if (calls.errors.length > 0) {
    throw new Error('sleep should pass the executable check, got: ' + calls.errors[0]);
  }
  await sleep(1600); // watchdog is 1000ms
  ok(calls.errors.length === 1, 'watchdog shows one error popup');
  ok(/did not respond/.test(calls.errors[0]), 'popup mentions unresponsive server');
  ok(/unavailable/.test(calls.errors[0]), 'popup says features unavailable');
  await ext.deactivate();
}

async function scenarioCloseThrottled() {
  const { vscode, calls } = makeVscode({
    'server.path': '/bin/sleep',
    'server.args': ['5'],
    'server.maxRestarts': 3,
    'trace.server': 'off',
    'server.startTimeout': 0,
  });
  const ext = loadExtension(vscode);
  await ext.activate(fakeContext());
  const handler = lastClientOptions.errorHandler;
  ok(handler, 'error handler installed');
  handler.closed();
  handler.closed(); // flapping: second close must not popup again
  await sleep(50);
  ok(calls.warnings.length === 1, 'unexpected close shows one throttled warning');
  ok(/unavailable/.test(calls.warnings[0]), 'warning says features unavailable');
  await ext.deactivate();
}

async function scenarioCrashBudget() {
  const { vscode, calls } = makeVscode({
    'server.path': '/bin/sleep',
    'server.args': ['5'],
    'server.maxRestarts': 3,
    'trace.server': 'off',
    'server.startTimeout': 0,
  });
  const ext = loadExtension(vscode);
  await ext.activate(fakeContext());
  const handler = lastClientOptions.errorHandler;
  let action = null;
  for (let i = 0; i < 5; i++) {
    action = handler.error(new Error('boom'), undefined, i + 1);
  }
  ok(action && action.action === 2, 'budget exhaustion requests shutdown');
  ok(calls.errors.length === 1, 'crash budget shows one error popup');
  ok(/keeps crashing/.test(calls.errors[0]), 'popup mentions repeated crashes');
  const before = calls.warnings.length;
  handler.closed(); // already notified: must stay silent
  await sleep(50);
  ok(calls.warnings.length === before, 'no extra popup after shutdown notice');
  await ext.deactivate();
}

async function main() {
  console.log('client notification tests');
  if (process.platform === 'win32') {
    console.log('  SKIP (posix-only sleep binary)');
    return;
  }
  await scenarioMissingServer();
  await scenarioWatchdogDeterministic();
  await scenarioCloseThrottled();
  await scenarioCrashBudget();
  console.log(`  PASS (${passed} assertions)`);
}

module.exports = main;
if (require.main === module) {
  main().catch((e) => {
    console.error('  FAIL:', e.message);
    process.exit(1);
  });
}
