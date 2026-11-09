import * as child_process from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import {
  CloseAction,
  ErrorAction,
  ErrorHandler,
  LanguageClient,
  LanguageClientOptions,
  RevealOutputChannelOn,
  ServerOptions,
  State,
  Trace,
  TransportKind,
} from 'vscode-languageclient/node';

const LANGUAGE_ID = 'typelua';
const OUTPUT_NAME = 'TypeLua Language Server';

let client: LanguageClient | undefined;
let statusItem: vscode.StatusBarItem;
let outputChannel: vscode.OutputChannel;
let crashTimestamps: number[] = [];
let userStopping = false;

// Notification / watchdog state. attemptId generations guard every async
// callback so a stale start attempt can never popup or touch status.
let attemptId = 0;
let startTimer: ReturnType<typeof setTimeout> | undefined;
let attemptDisposables: vscode.Disposable[] = [];
let shutdownNotified = false;
let lastClosePopupAt = 0;
const CLOSE_POPUP_MIN_INTERVAL_MS = 30_000;

const BTN_SHOW_OUTPUT = 'Show Output';
const BTN_OPEN_SETTINGS = 'Open Settings';
const BTN_RETRY = 'Retry';
const BTN_RESTART = 'Restart Server';

interface ServerResolution {
  command: string;
  source: 'settings' | 'bundled' | 'path';
}

function bundledServerName(): string {
  // Matches the layout documented in server/README.md:
  //   server/tlua-<platform>-<arch>[.exe]
  const plat =
    process.platform === 'win32'
      ? 'win32'
      : process.platform === 'darwin'
        ? 'darwin'
        : 'linux';
  // Release assets use Go's GOARCH spelling (amd64, arm64).
  const arch =
    process.arch === 'x64'
      ? 'amd64'
      : process.arch === 'arm64'
        ? 'arm64'
        : process.arch;
  const ext = process.platform === 'win32' ? '.exe' : '';
  return `tlua-${plat}-${arch}${ext}`;
}

function onPath(cmd: string): boolean {
  try {
    const probe = process.platform === 'win32' ? 'where' : 'command -v';
    const r = child_process.spawnSync(probe, [cmd], {
      shell: process.platform === 'win32' ? true : '/bin/sh',
      stdio: 'ignore',
    });
    return r.status === 0;
  } catch {
    return false;
  }
}

/** Resolve the server executable: settings > bundled > PATH. */
function resolveServer(context: vscode.ExtensionContext): ServerResolution {
  const cfg = vscode.workspace.getConfiguration('typelua');
  const configured = (cfg.get<string>('server.path') ?? '').trim();
  if (configured.length > 0) {
    return { command: configured, source: 'settings' };
  }
  const bundled = path.join(context.extensionPath, 'server', bundledServerName());
  try {
    fs.accessSync(bundled, fs.constants.X_OK);
    return { command: bundled, source: 'bundled' };
  } catch {
    // fall through to PATH
  }
  return { command: 'tlua', source: 'path' };
}

function serverArgs(): string[] {
  const cfg = vscode.workspace.getConfiguration('typelua');
  const args = cfg.get<string[]>('server.args');
  if (Array.isArray(args)) {
    return args;
  }
  return ['lsp'];
}

function maxRestarts(): number {
  const cfg = vscode.workspace.getConfiguration('typelua');
  const n = cfg.get<number>('server.maxRestarts');
  if (typeof n === 'number' && Number.isFinite(n) && n >= 0) {
    return Math.floor(n);
  }
  return 3;
}

function traceSetting(): Trace {
  const cfg = vscode.workspace.getConfiguration('typelua');
  switch (cfg.get<string>('trace.server')) {
    case 'messages':
      return Trace.Messages;
    case 'verbose':
      return Trace.Verbose;
    default:
      return Trace.Off;
  }
}

function startTimeoutMs(): number {
  const cfg = vscode.workspace.getConfiguration('typelua');
  const n = cfg.get<number>('server.startTimeout');
  if (typeof n !== 'number' || !Number.isFinite(n) || n <= 0) {
    return 0; // 0 or invalid disables the watchdog
  }
  return Math.min(Math.max(Math.floor(n), 1000), 60000);
}

/** Human-readable reason why path cannot be used as the server, or null. */
function describeExecutableProblem(p: string): string | null {
  let st: fs.Stats;
  try {
    st = fs.statSync(p);
  } catch {
    return `not found: ${p}`;
  }
  if (!st.isFile()) {
    return `not an executable file (it is a directory or special file): ${p}`;
  }
  try {
    fs.accessSync(p, fs.constants.X_OK);
  } catch {
    return `not executable (missing execute permission): ${p}`;
  }
  return null;
}

function clearStartTimer(): void {
  if (startTimer !== undefined) {
    clearTimeout(startTimer);
    startTimer = undefined;
  }
}

function disposeAttempt(): void {
  clearStartTimer();
  for (const d of attemptDisposables) {
    try {
      d.dispose();
    } catch {
      // best-effort
    }
  }
  attemptDisposables = [];
}

async function openServerSettings(): Promise<void> {
  await vscode.commands.executeCommand(
    'workbench.action.openSettings',
    'typelua.server.path',
  );
}

async function restartFlow(context: vscode.ExtensionContext): Promise<void> {
  // Manual retry: a fresh attempt may notify again. Commands, debuggers,
  // test controller and file watchers were registered once by activate();
  // registering them again throws "command ... already exists" and aborts
  // the restart before the language client is recreated.
  lastClosePopupAt = 0;
  await stopClient();
  extContext = context;
  await startClient(context);
}

function setStatus(text: string, tooltip: string, error: boolean): void {
  statusItem.text = text;
  statusItem.tooltip = tooltip;
  statusItem.backgroundColor = error
    ? new vscode.ThemeColor('statusBarItem.errorBackground')
    : undefined;
}

function makeErrorHandler(context: vscode.ExtensionContext): ErrorHandler {
  return {
    error(
      _error: Error,
      _message: Parameters<ErrorHandler['error']>[1],
      count: number | undefined,
    ): { action: ErrorAction } {
      const now = Date.now();
      crashTimestamps.push(now);
      crashTimestamps = crashTimestamps.filter((t) => now - t < 60_000);
      if (crashTimestamps.length > maxRestarts()) {
        if (shutdownNotified) {
          return { action: ErrorAction.Shutdown }; // already told the user
        }
        shutdownNotified = true;
        setStatus('$(error) TypeLua', 'Language server stopped after repeated crashes', true);
        outputChannel.appendLine(
          `language server crashed ${crashTimestamps.length} times in the last minute; automatic restarts disabled`,
        );
        void (async () => {
          const choice = await vscode.window.showErrorMessage(
            `TypeLua language server keeps crashing ` +
              `(${crashTimestamps.length} times in the last minute), so automatic restarts are paused. ` +
              `Diagnostics, completion and go-to-definition are unavailable.`,
            BTN_SHOW_OUTPUT,
            BTN_RESTART,
          );
          if (choice === BTN_SHOW_OUTPUT) {
            outputChannel.show(true);
          } else if (choice === BTN_RESTART) {
            await restartFlow(context);
          }
        })();
        return { action: ErrorAction.Shutdown };
      }
      setStatus(
        '$(sync~spin) TypeLua',
        `Language server crashed${count !== undefined ? ` (${count})` : ''}, restarting…`,
        false,
      );
      return { action: ErrorAction.Continue };
    },

    closed(): { action: CloseAction } {
      if (userStopping) {
        return { action: CloseAction.DoNotRestart };
      }
      setStatus('$(circle-slash) TypeLua', 'Language server connection closed', true);
      if (shutdownNotified) {
        return { action: CloseAction.DoNotRestart };
      }
      // Throttle: a flapping server must not spam the notification area.
      const now = Date.now();
      if (now - lastClosePopupAt < CLOSE_POPUP_MIN_INTERVAL_MS) {
        return { action: CloseAction.DoNotRestart };
      }
      lastClosePopupAt = now;
      outputChannel.appendLine('language server connection closed unexpectedly');
      void (async () => {
        const choice = await vscode.window.showWarningMessage(
          'TypeLua language server connection closed unexpectedly. ' +
            'Diagnostics, completion and go-to-definition are unavailable.',
          BTN_RESTART,
          BTN_SHOW_OUTPUT,
        );
        if (choice === BTN_RESTART) {
          await restartFlow(context);
        } else if (choice === BTN_SHOW_OUTPUT) {
          outputChannel.show(true);
        }
      })();
      return { action: CloseAction.DoNotRestart };
    },
  };
}

/** Watchdog: the server process started but never reached Running. */
async function onStartTimeout(
  context: vscode.ExtensionContext,
  attempt: number,
  commandLine: string,
): Promise<void> {
  if (attempt !== attemptId || !client || client.state === State.Running) {
    return;
  }
  const secs = Math.round((startTimeoutMs() || 10000) / 1000);
  setStatus(
    '$(error) TypeLua',
    `Language server did not respond within ${secs}s (${commandLine})`,
    true,
  );
  outputChannel.appendLine(
    `language server did not reach running state within ${secs}s (command: ${commandLine}); ` +
      `it may be the wrong binary, missing "lsp" support, or blocked on startup`,
  );
  const choice = await vscode.window.showErrorMessage(
    `TypeLua language server did not respond within ${secs}s (started "${commandLine}"). ` +
      `Diagnostics, completion and go-to-definition are unavailable.`,
    BTN_SHOW_OUTPUT,
    BTN_OPEN_SETTINGS,
    BTN_RETRY,
  );
  if (attempt !== attemptId) {
    return; // a newer attempt superseded this popup
  }
  if (choice === BTN_SHOW_OUTPUT) {
    outputChannel.show(true);
  } else if (choice === BTN_OPEN_SETTINGS) {
    await openServerSettings();
  } else if (choice === BTN_RETRY) {
    await restartFlow(context);
  }
}

async function startClient(context: vscode.ExtensionContext): Promise<void> {
  userStopping = false;
  shutdownNotified = false;
  const attempt = ++attemptId;
  disposeAttempt();
  const resolved = resolveServer(context);
  const args = serverArgs();
  const commandLine = `${resolved.command} ${args.join(' ')}`.trim();

  if (resolved.source === 'settings') {
    const problem = describeExecutableProblem(resolved.command);
    if (problem !== null) {
      setStatus('$(error) TypeLua', `Server unusable: ${problem}`, true);
      outputChannel.appendLine(`language server unusable: ${problem}`);
      const choice = await vscode.window.showErrorMessage(
        `TypeLua language server is unusable (${problem}). ` +
          `Install tlua or fix the "typelua.server.path" setting. ` +
          `Diagnostics, completion and go-to-definition are unavailable.`,
        BTN_OPEN_SETTINGS,
        BTN_SHOW_OUTPUT,
        BTN_RETRY,
      );
      if (choice === BTN_OPEN_SETTINGS) {
        await openServerSettings();
      } else if (choice === BTN_SHOW_OUTPUT) {
        outputChannel.show(true);
      } else if (choice === BTN_RETRY) {
        await restartFlow(context);
      }
      return;
    }
  } else if (resolved.source === 'path' && !onPath(resolved.command)) {
    setStatus('$(error) TypeLua', 'tlua not found on PATH', true);
    outputChannel.appendLine(
      'language server not found: no "tlua" on PATH and no bundled server; ' +
        'set "typelua.server.path" to continue',
    );
    const choice = await vscode.window.showErrorMessage(
      'TypeLua: could not find the language server (no "tlua" on PATH). ' +
        'Install tlua, or set "typelua.server.path" to its location. ' +
        'Diagnostics, completion and go-to-definition are unavailable.',
      BTN_OPEN_SETTINGS,
      BTN_SHOW_OUTPUT,
      BTN_RETRY,
    );
    if (choice === BTN_OPEN_SETTINGS) {
      await openServerSettings();
    } else if (choice === BTN_SHOW_OUTPUT) {
      outputChannel.show(true);
    } else if (choice === BTN_RETRY) {
      await restartFlow(context);
    }
    return;
  }

  const serverOptions: ServerOptions = {
    command: resolved.command,
    args,
    transport: TransportKind.stdio,
    options: { cwd: os.homedir() },
  };
  const clientOptions: LanguageClientOptions = {
    documentSelector: [
      { scheme: 'file', language: LANGUAGE_ID },
      { scheme: 'untitled', language: LANGUAGE_ID },
    ],
    outputChannelName: OUTPUT_NAME,
    revealOutputChannelOn: RevealOutputChannelOn.Never,
    traceOutputChannel: outputChannel,
    errorHandler: makeErrorHandler(context),
  };

  client = new LanguageClient(
    'typelua',
    'TypeLua Language Server',
    serverOptions,
    clientOptions,
  );
  client.registerProposedFeatures?.();
  setStatus('$(sync~spin) TypeLua', 'Starting language server…', false);

  attemptDisposables.push(
    client.onDidChangeState((e) => {
      if (attempt !== attemptId) {
        return; // stale attempt
      }
      if (e.newState === State.Running) {
        clearStartTimer();
        setStatus('$(check) TypeLua', `Language server running (${commandLine})`, false);
      }
    }),
  );

  // Watchdog: the process may exist yet never answer (wrong binary,
  // missing "lsp" support, blocked startup). Never kill it here — a slow
  // first start is legitimate; just tell the user loudly.
  const timeoutMs = startTimeoutMs();
  if (timeoutMs > 0) {
    startTimer = setTimeout(() => {
      void onStartTimeout(context, attempt, commandLine);
    }, timeoutMs);
  }

  // NOTE: the client is intentionally NOT added to context.subscriptions:
  // its lifecycle is managed across restarts by stopClient()/startClient().
  try {
    await client.start();
    await client.setTrace(traceSetting());
  } catch (err) {
    if (attempt !== attemptId) {
      return;
    }
    clearStartTimer();
    const msg = err instanceof Error ? err.message : String(err);
    setStatus('$(error) TypeLua', `Failed to start language server: ${msg}`, true);
    outputChannel.appendLine(`failed to start language server (${commandLine}): ${msg}`);
    const choice = await vscode.window.showErrorMessage(
      `TypeLua: failed to start language server ("${commandLine}"): ${msg}. ` +
        `Diagnostics, completion and go-to-definition are unavailable.`,
      BTN_SHOW_OUTPUT,
      BTN_OPEN_SETTINGS,
      BTN_RETRY,
    );
    if (choice === BTN_SHOW_OUTPUT) {
      outputChannel.show(true);
    } else if (choice === BTN_OPEN_SETTINGS) {
      await openServerSettings();
    } else if (choice === BTN_RETRY) {
      await restartFlow(context);
    }
  }
}

async function stopClient(): Promise<void> {
  userStopping = true;
  attemptId++; // invalidate pending watchdogs/popups
  disposeAttempt();
  if (client) {
    const c = client;
    client = undefined;
    try {
      await c.stop(2000);
    } catch {
      // Stopping is best-effort; the process is torn down regardless.
    }
    c.dispose?.();
  }
  crashTimestamps = [];
}


// ---------------------------------------------------------------------------
// Commands, tests and debugging
// ---------------------------------------------------------------------------

let extContext: vscode.ExtensionContext | undefined;
let testController: vscode.TestController | undefined;
let discoveryTimer: ReturnType<typeof setTimeout> | undefined;
const testItemIndex = new Map<string, vscode.TestItem>();

interface ListedCase {
  module: string;
  case: string;
  file: string;
}

interface ExecResult {
  stdout: string;
  stderr: string;
  code: number;
}

function tluaExecutable(): string | undefined {
  if (!extContext) return undefined;
  const resolved = resolveServer(extContext);
  if (resolved.source === 'path' && !onPath(resolved.command)) {
    void vscode.window.showErrorMessage(
      'TypeLua: cannot find "tlua" on PATH. Set "typelua.server.path" to the compiler binary.',
    );
    return undefined;
  }
  return resolved.command;
}

function execFileP(command: string, args: string[], cwd?: string): Promise<ExecResult> {
  return new Promise((resolvePromise) => {
    child_process.execFile(
      command,
      args,
      { cwd, maxBuffer: 64 * 1024 * 1024 },
      (err, stdout, stderr) => {
        let code = 0;
        if (err) {
          const raw = (err as NodeJS.ErrnoException & { code?: unknown }).code;
          code = typeof raw === 'number' ? raw : 1;
        }
        resolvePromise({ stdout: stdout ?? '', stderr: stderr ?? '', code });
      },
    );
  });
}

function runTask(name: string, args: string[], cwd?: string): void {
  const exe = tluaExecutable();
  if (!exe) return;
  const folder = cwd ? vscode.workspace.getWorkspaceFolder(vscode.Uri.file(cwd)) : undefined;
  const task = new vscode.Task(
    { type: 'typelua', name },
    folder ?? vscode.TaskScope.Workspace,
    name,
    'typelua',
    new vscode.ShellExecution(exe, args, { cwd }),
  );
  task.presentationOptions = {
    reveal: vscode.TaskRevealKind.Always,
    panel: vscode.TaskPanelKind.Dedicated,
    clear: true,
    showReuseMessage: false,
  };
  void vscode.tasks.executeTask(task);
}

function activeTypeluaFile(): vscode.Uri | undefined {
  const editor = vscode.window.activeTextEditor;
  if (!editor || editor.document.languageId !== LANGUAGE_ID) return undefined;
  return editor.document.uri;
}

async function saveIfDirty(uri: vscode.Uri): Promise<void> {
  const doc = vscode.workspace.textDocuments.find((d) => d.uri.toString() === uri.toString());
  if (doc && doc.isDirty) await doc.save();
}

function workspaceCwd(uri?: vscode.Uri): string | undefined {
  if (uri) {
    const folder = vscode.workspace.getWorkspaceFolder(uri);
    if (folder) return folder.uri.fsPath;
    return path.dirname(uri.fsPath);
  }
  return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
}

function registerCommands(context: vscode.ExtensionContext): void {
  const config = () => vscode.workspace.getConfiguration('typelua');

  context.subscriptions.push(
    vscode.commands.registerCommand('typelua.runFile', async () => {
      const uri = activeTypeluaFile();
      if (!uri) {
        void vscode.window.showErrorMessage('TypeLua: open a .tl file first.');
        return;
      }
      await saveIfDirty(uri);
      const args = config().get<boolean>('run.check')
        ? ['run', '--check', uri.fsPath]
        : ['run', uri.fsPath];
      runTask('TypeLua: Run ' + path.basename(uri.fsPath), args, workspaceCwd(uri));
    }),
    vscode.commands.registerCommand('typelua.debugFile', async () => {
      const uri = activeTypeluaFile();
      if (!uri) {
        void vscode.window.showErrorMessage('TypeLua: open a .tl file first.');
        return;
      }
      await saveIfDirty(uri);
      const folder = vscode.workspace.getWorkspaceFolder(uri);
      await vscode.debug.startDebugging(folder, {
        type: 'typelua',
        request: 'launch',
        name: 'Debug ' + path.basename(uri.fsPath),
        program: uri.fsPath,
      });
    }),
    vscode.commands.registerCommand('typelua.check', () => {
      runTask('TypeLua: Check', ['check'], workspaceCwd());
    }),
    vscode.commands.registerCommand('typelua.build', () => {
      runTask('TypeLua: Build', ['build'], workspaceCwd());
    }),
    vscode.commands.registerCommand('typelua.testWorkspace', () => {
      const extra = config().get<string[]>('test.args') ?? [];
      runTask('TypeLua: Test', ['test', ...extra], workspaceCwd());
    }),
    vscode.commands.registerCommand('typelua.testFile', async () => {
      const uri = activeTypeluaFile();
      if (!uri) {
        void vscode.window.showErrorMessage('TypeLua: open a test file first.');
        return;
      }
      await saveIfDirty(uri);
      const extra = config().get<string[]>('test.args') ?? [];
      runTask(
        'TypeLua: Test ' + path.basename(uri.fsPath),
        ['test', uri.fsPath, ...extra],
        workspaceCwd(uri),
      );
    }),
    vscode.commands.registerCommand('typelua.runExample', async () => {
      const exe = tluaExecutable();
      if (!exe) return;
      const cwd = workspaceCwd();
      const res = await execFileP(exe, ['example'], cwd);
      const examples: Array<{ name: string; detail: string }> = [];
      for (const line of res.stdout.split('\n')) {
        const match = /^\s{2}(\S+)(?:\s{2,}(.*))?$/.exec(line);
        if (match) examples.push({ name: match[1], detail: match[2] ?? '' });
      }
      if (examples.length === 0) {
        void vscode.window.showWarningMessage('TypeLua: no examples found (examples/*.tl or examples/*/main.tl).');
        return;
      }
      const picked = await vscode.window.showQuickPick(
        examples.map((e) => ({ label: e.name, description: e.detail })),
        { placeHolder: 'Select a TypeLua example to run' },
      );
      if (picked) runTask('TypeLua: Example ' + picked.label, ['example', picked.label], cwd);
    }),
  );
}

// --- Debug adapter ---------------------------------------------------------

function registerDebugging(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    vscode.debug.registerDebugAdapterDescriptorFactory('typelua', {
      createDebugAdapterDescriptor: (session) => {
        const exe = tluaExecutable();
        if (!exe) return undefined;
        return new vscode.DebugAdapterExecutable(exe, ['dap'], {
          cwd: session.workspaceFolder?.uri.fsPath,
        });
      },
    }),
    vscode.debug.registerDebugConfigurationProvider('typelua', {
      resolveDebugConfiguration: (folder, configuration) => {
        const config = configuration;
        if (!config.type) config.type = 'typelua';
        if (!config.request) config.request = 'launch';
        if (!config.program) {
          const uri = activeTypeluaFile();
          if (uri) config.program = uri.fsPath;
        }
        if (!config.program) {
          void vscode.window.showErrorMessage('TypeLua: launch.json needs a "program" (a .tl file).');
          return undefined;
        }
        if (config.check === undefined) {
          config.check = vscode.workspace.getConfiguration('typelua').get<boolean>('debug.check') ?? false;
        }
        if (!config.lua) {
          const lua = vscode.workspace.getConfiguration('typelua').get<string>('lua.path') ?? '';
          if (lua) config.lua = lua;
        }
        if (!config.cwd && folder) config.cwd = folder.uri.fsPath;
        return config;
      },
      provideDebugConfigurations: () => [
        {
          type: 'typelua',
          request: 'launch',
          name: 'Debug TypeLua',
          program: '${file}',
          stopOnEntry: true,
        },
      ],
    }),
  );
}

interface DebugRunEntry {
  run: vscode.TestRun;
  item: vscode.TestItem;
  children: vscode.TestItem[];
}

const sessionTestResults = new Map<string, { ok: boolean; message: string }>();
const sessionTestEntries = new Map<string, DebugRunEntry>();
const pendingDebugItems: Array<{ item: vscode.TestItem; run: vscode.TestRun; children: vscode.TestItem[] }> = [];
const outstandingByRun = new Map<vscode.TestRun, number>();

function registerTestDebugTracker(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    vscode.debug.registerDebugAdapterTrackerFactory('typelua', {
      createDebugAdapterTracker: (session) => ({
        onDidSendMessage: (message: any) => {
          if (message?.type === 'event' && message.event === 'typelua/testResult') {
            sessionTestResults.set(session.id, {
              ok: Boolean(message.body?.ok),
              message: String(message.body?.message ?? ''),
            });
          }
        },
      }),
    }),
    vscode.debug.onDidStartDebugSession((session) => {
      if (session.configuration?.type !== 'typelua' || !session.configuration?.test) return;
      const pending = pendingDebugItems.shift();
      if (pending) sessionTestEntries.set(session.id, pending);
    }),
    vscode.debug.onDidTerminateDebugSession((session) => {
      const entry = sessionTestEntries.get(session.id);
      if (!entry) return;
      sessionTestEntries.delete(session.id);
      const result = sessionTestResults.get(session.id);
      sessionTestResults.delete(session.id);
      const ok = result?.ok ?? false;
      if (ok) {
        entry.run.passed(entry.item);
        for (const child of entry.children) entry.run.passed(child);
      } else {
        entry.run.failed(entry.item, new vscode.TestMessage(result?.message || 'test failed'));
      }
      const left = (outstandingByRun.get(entry.run) ?? 1) - 1;
      if (left <= 0) {
        outstandingByRun.delete(entry.run);
        entry.run.end();
      } else {
        outstandingByRun.set(entry.run, left);
      }
    }),
  );
}

// --- Test Explorer ---------------------------------------------------------

function parseCaseResults(stdout: string): Array<{ module: string; case: string; ok: boolean; message: string }> {
  const out: Array<{ module: string; case: string; ok: boolean; message: string }> = [];
  for (const line of stdout.split('\n')) {
    const text = line.trim();
    if (!text.startsWith('{')) continue;
    try {
      const parsed = JSON.parse(text);
      if (typeof parsed.case === 'string' && typeof parsed.ok === 'boolean') {
        out.push({
          module: String(parsed.module ?? ''),
          case: parsed.case,
          ok: parsed.ok,
          message: String(parsed.message ?? ''),
        });
      }
    } catch {
      // ignore non-JSON lines (task banners, etc.)
    }
  }
  return out;
}

async function discoverInto(controller: vscode.TestController): Promise<void> {
  const exe = tluaExecutable();
  if (!exe) return;
  const roots: vscode.TestItem[] = [];
  testItemIndex.clear();
  for (const folder of vscode.workspace.workspaceFolders ?? []) {
    const res = await execFileP(exe, ['test', '--list', '--format=json'], folder.uri.fsPath);
    const byFile = new Map<string, ListedCase[]>();
    for (const line of res.stdout.split('\n')) {
      const text = line.trim();
      if (!text.startsWith('{')) continue;
      try {
        const parsed = JSON.parse(text);
        if (typeof parsed.file !== 'string' || typeof parsed.case !== 'string') continue;
        const list = byFile.get(parsed.file) ?? [];
        list.push({ module: String(parsed.module ?? ''), case: parsed.case, file: parsed.file });
        byFile.set(parsed.file, list);
      } catch {
        // ignore
      }
    }
    for (const [file, cases] of byFile) {
      const uri = vscode.Uri.file(file);
      const fileItem = controller.createTestItem('file:' + file, path.basename(file), uri);
      const children: vscode.TestItem[] = [];
      for (const c of cases) {
        const childId = 'case:' + file + '::' + c.case;
        const child = controller.createTestItem(childId, c.case, uri);
        testItemIndex.set(childId, child);
        children.push(child);
      }
      fileItem.children.replace(children);
      roots.push(fileItem);
    }
  }
  controller.items.replace(roots);
}

function scheduleDiscovery(): void {
  if (!testController) return;
  if (discoveryTimer) clearTimeout(discoveryTimer);
  discoveryTimer = setTimeout(() => {
    discoveryTimer = undefined;
    if (testController) void discoverInto(testController);
  }, 400);
}

function allRootItems(controller: vscode.TestController): vscode.TestItem[] {
  const out: vscode.TestItem[] = [];
  controller.items.forEach((item) => out.push(item));
  return out;
}

function expandRunItems(items: readonly vscode.TestItem[]): vscode.TestItem[] {
  const out: vscode.TestItem[] = [];
  for (const item of items) {
    if (item.children.size > 0 && !item.id.startsWith('case:')) out.push(item);
    else out.push(item);
  }
  return out;
}

async function runTestRequest(
  controller: vscode.TestController,
  request: vscode.TestRunRequest,
  token: vscode.CancellationToken,
): Promise<void> {
  const run = controller.createTestRun(request);
  const exe = tluaExecutable();
  if (!exe) {
    run.end();
    return;
  }
  const extra = vscode.workspace.getConfiguration('typelua').get<string[]>('test.args') ?? [];
  const items = request.include ? [...request.include] : allRootItems(controller);
  for (const item of expandRunItems(items)) {
    if (token.isCancellationRequested) break;
    const uri = item.uri;
    if (!uri || uri.scheme !== 'file') continue;
    const cwd = workspaceCwd(uri);
    const isFile = item.children.size > 0 && !item.id.startsWith('case:');
    const caseName = item.id.startsWith('case:') ? item.label : undefined;
    run.started(item);
    const children: vscode.TestItem[] = [];
    if (isFile) {
      for (const [, child] of item.children) {
        run.started(child);
        children.push(child);
      }
    }
    try {
      const args = ['test', uri.fsPath, ...extra];
      if (caseName) args.push('--case', caseName);
      args.push('--format=json');
      const res = await execFileP(exe, args, cwd);
      const results = parseCaseResults(res.stdout);
      if (results.length === 0) {
        const message = res.stderr.trim() || 'no test results were produced';
        if (isFile) run.failed(item, new vscode.TestMessage(message));
        else run.failed(item, new vscode.TestMessage(message));
        continue;
      }
      let anyFailed = false;
      for (const r of results) {
        const target = isFile
          ? item.children.get('case:' + uri.fsPath + '::' + r.case) ?? item
          : item;
        if (target !== item && !target.id.startsWith('case:')) {
          // unknown case (should not happen); fall back to the file item
        }
        if (r.ok) run.passed(target);
        else {
          anyFailed = true;
          run.failed(target, new vscode.TestMessage(r.message || 'assertion failed'));
        }
      }
      if (isFile) {
        if (anyFailed) run.failed(item, new vscode.TestMessage('one or more cases failed'));
        else run.passed(item);
      }
    } catch (err) {
      run.errored(item, new vscode.TestMessage(err instanceof Error ? err.message : String(err)));
    }
  }
  run.end();
}

async function debugTestRequest(
  controller: vscode.TestController,
  request: vscode.TestRunRequest,
  token: vscode.CancellationToken,
): Promise<void> {
  const run = controller.createTestRun(request);
  const items = request.include ? [...request.include] : allRootItems(controller);
  let started = 0;
  for (const item of expandRunItems(items)) {
    if (token.isCancellationRequested) break;
    const uri = item.uri;
    if (!uri || uri.scheme !== 'file') continue;
    const folder = vscode.workspace.getWorkspaceFolder(uri);
    const isFile = item.children.size > 0 && !item.id.startsWith('case:');
    const caseName = item.id.startsWith('case:') ? item.label : undefined;
    const children: vscode.TestItem[] = [];
    if (isFile) for (const [, child] of item.children) children.push(child);

    run.started(item);
    outstandingByRun.set(run, (outstandingByRun.get(run) ?? 0) + 1);
    pendingDebugItems.push({ item, run, children });
    const ok = await vscode.debug.startDebugging(folder, {
      type: 'typelua',
      request: 'launch',
      name: 'Debug ' + item.label,
      program: uri.fsPath,
      test: uri.fsPath,
      ...(caseName ? { testCase: caseName } : {}),
    });
    if (!ok) {
      pendingDebugItems.pop();
      const left = (outstandingByRun.get(run) ?? 1) - 1;
      if (left <= 0) {
        outstandingByRun.delete(run);
        run.end();
      } else {
        outstandingByRun.set(run, left);
      }
      continue;
    }
    started++;
  }
  if (started === 0) run.end();
}

function setupTesting(context: vscode.ExtensionContext): void {
  const controller = vscode.tests.createTestController('typelua', 'TypeLua');
  testController = controller;
  context.subscriptions.push(controller);
  controller.refreshHandler = async () => {
    await discoverInto(controller);
  };
  controller.createRunProfile(
    'Run',
    vscode.TestRunProfileKind.Run,
    (request, token) => runTestRequest(controller, request, token),
    true,
  );
  controller.createRunProfile(
    'Debug',
    vscode.TestRunProfileKind.Debug,
    (request, token) => debugTestRequest(controller, request, token),
    true,
  );

  const watchers = [
    vscode.workspace.createFileSystemWatcher('**/*.tl'),
    vscode.workspace.createFileSystemWatcher('**/tlua.json'),
  ];
  for (const watcher of watchers) {
    const handler = (uri: vscode.Uri) => {
      if (uri.fsPath.includes('tlua_modules') || uri.fsPath.includes(`${path.sep}dist${path.sep}`)) return;
      scheduleDiscovery();
    };
    watcher.onDidCreate(handler);
    watcher.onDidChange(handler);
    watcher.onDidDelete(handler);
    context.subscriptions.push(watcher);
  }
  void discoverInto(controller);
}

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  outputChannel = vscode.window.createOutputChannel(OUTPUT_NAME);
  context.subscriptions.push(outputChannel);

  statusItem = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Right,
    100,
  );
  statusItem.command = 'typelua.showOutput';
  context.subscriptions.push(statusItem);
  setStatus('$(sync~spin) TypeLua', 'TypeLua extension activated', false);
  statusItem.show();

  context.subscriptions.push(
    vscode.commands.registerCommand('typelua.restartServer', async () => {
      try {
        await restartFlow(context);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        setStatus('$(error) TypeLua', `Restart failed: ${msg}`, true);
        outputChannel.appendLine(`restart failed: ${msg}`);
        void vscode.window.showErrorMessage(`TypeLua: restart failed: ${msg}`);
      }
    }),
    vscode.commands.registerCommand('typelua.showOutput', () => {
      outputChannel.show(true);
    }),
    vscode.workspace.onDidChangeConfiguration(async (e) => {
      if (
        e.affectsConfiguration('typelua.server.path') ||
        e.affectsConfiguration('typelua.server.args')
      ) {
        const choice = await vscode.window.showInformationMessage(
          'TypeLua server settings changed. Restart the language server to apply them?',
          'Restart',
          'Later',
        );
        if (choice === 'Restart') {
          await stopClient();
          await startClient(context);
        }
      } else if (e.affectsConfiguration('typelua.trace.server') && client) {
        await client.setTrace(traceSetting());
      }
    }),
  );

  extContext = context;
  registerCommands(context);
  registerDebugging(context);
  registerTestDebugTracker(context);
  setupTesting(context);

  await startClient(context);
}

export async function deactivate(): Promise<void> {
  await stopClient();
}
