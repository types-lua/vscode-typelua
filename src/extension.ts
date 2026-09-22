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
  const arch =
    process.arch === 'x64'
      ? 'x64'
      : process.arch === 'arm64'
        ? 'arm64'
        : process.arch === 'riscv64'
          ? 'riscv64'
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
  // Manual retry: a fresh attempt may notify again.
  lastClosePopupAt = 0;
  await stopClient();
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

  await startClient(context);
}

export async function deactivate(): Promise<void> {
  await stopClient();
}
