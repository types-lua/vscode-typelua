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

function setStatus(text: string, tooltip: string, error: boolean): void {
  statusItem.text = text;
  statusItem.tooltip = tooltip;
  statusItem.backgroundColor = error
    ? new vscode.ThemeColor('statusBarItem.errorBackground')
    : undefined;
}

class TlErrorHandler implements ErrorHandler {
  error(
    _error: Error,
    _message: Parameters<ErrorHandler['error']>[1],
    count: number | undefined,
  ): { action: ErrorAction } {
    const now = Date.now();
    crashTimestamps.push(now);
    crashTimestamps = crashTimestamps.filter((t) => now - t < 60_000);
    if (crashTimestamps.length > maxRestarts()) {
      void vscode.window.showErrorMessage(
        `TypeLua language server crashed ${crashTimestamps.length} times in the last minute. Automatic restarts are disabled; use "TypeLua: Restart Language Server" to retry.`,
      );
      setStatus('$(error) TypeLua', 'Language server stopped after repeated crashes', true);
      return { action: ErrorAction.Shutdown };
    }
    setStatus(
      '$(sync~spin) TypeLua',
      `Language server crashed${count !== undefined ? ` (${count})` : ''}, restarting…`,
      false,
    );
    return { action: ErrorAction.Continue };
  }

  closed(): { action: CloseAction } {
    if (!userStopping) {
      setStatus('$(circle-slash) TypeLua', 'Language server connection closed', true);
    }
    return { action: CloseAction.DoNotRestart };
  }
}

async function startClient(context: vscode.ExtensionContext): Promise<void> {
  userStopping = false;
  const resolved = resolveServer(context);
  const args = serverArgs();

  if (resolved.source === 'settings') {
    try {
      fs.accessSync(resolved.command, fs.constants.X_OK);
    } catch {
      setStatus('$(error) TypeLua', `Server not executable: ${resolved.command}`, true);
      const open = 'Open Settings';
      const choice = await vscode.window.showErrorMessage(
        `TypeLua: language server not found or not executable: ${resolved.command}. ` +
          `Install tlua, or fix the "typelua.server.path" setting.`,
        open,
      );
      if (choice === open) {
        await vscode.commands.executeCommand(
          'workbench.action.openSettings',
          'typelua.server.path',
        );
      }
      return;
    }
  } else if (resolved.source === 'path' && !onPath(resolved.command)) {
    setStatus('$(error) TypeLua', 'tlua not found on PATH', true);
    const open = 'Open Settings';
    const choice = await vscode.window.showErrorMessage(
      'TypeLua: could not find the language server. Install tlua and make sure ' +
        'it is on PATH, or set "typelua.server.path" to its location.',
      open,
    );
    if (choice === open) {
      await vscode.commands.executeCommand(
        'workbench.action.openSettings',
        'typelua.server.path',
      );
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
    errorHandler: new TlErrorHandler(),
  };

  client = new LanguageClient(
    'typelua',
    'TypeLua Language Server',
    serverOptions,
    clientOptions,
  );
  client.registerProposedFeatures?.();
  setStatus('$(sync~spin) TypeLua', 'Starting language server…', false);

  client.onDidChangeState((e) => {
    if (e.newState === State.Running) {
      setStatus(
        '$(check) TypeLua',
        `Language server running (${resolved.command} ${args.join(' ')})`,
        false,
      );
    } else if (e.newState === State.Stopped && !userStopping) {
      // Unexpected stop is already surfaced by the error handler / closed().
    }
  });

  // NOTE: the client is intentionally NOT added to context.subscriptions:
  // its lifecycle is managed across restarts by stopClient()/startClient().
  try {
    await client.start();
    await client.setTrace(traceSetting());
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    setStatus('$(error) TypeLua', `Failed to start language server: ${msg}`, true);
    void vscode.window.showErrorMessage(
      `TypeLua: failed to start language server (${resolved.command}): ${msg}`,
    );
  }
}

async function stopClient(): Promise<void> {
  userStopping = true;
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
      await stopClient();
      await startClient(context);
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
