export interface ProcessEventMap {
  /**
   * Output from either stdout or stderr.
   */
  data: string;
  stdout: string;
  stderr: string;
  error: Error;
  /**
   * Emitted once with the exit code when the process terminates.
   */
  close: number;
}

export type ProcessEvent = keyof ProcessEventMap;
export type ProcessListener<E extends ProcessEvent> = (payload: ProcessEventMap[E]) => void;

export interface Process {
  readonly pid: string | null;
  readonly stdin: WritableProcessStream;
  readonly stdout: ReadableProcessStream;
  readonly stderr: ReadableProcessStream;
  readonly exitCode: number | null;

  on<E extends ProcessEvent>(event: E, listener: ProcessListener<E>): void;
  off<E extends ProcessEvent>(event: E, listener: ProcessListener<E>): void;

  write(data: string): Promise<void>;
  kill(): Promise<void>;
  isRunning(): Promise<boolean>;
}

export interface SpawnOptions {
  cwd?: string;
  env?: Record<string, string>;
  alpine?: boolean;
  /**
   * Preserved for API compatibility with upstream callers; unused by the Termux bridge.
   */
  shell?: string;
  /**
   * Preserved for compatibility with callers such as `git hash-object -t tree` passing `/dev/null`.
   */
  shellAppend?: string;
}

export interface ExecOptions extends SpawnOptions {
  /**
   * Maximum time (ms) to wait for the command. When exceeded the returned
   * result has `exitCode` 124 (same convention as coreutils `timeout`).
   */
  timeout?: number;
}

export interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  stdoutBytes?: Uint8Array;
  stderrBytes?: Uint8Array;
}

export interface BridgeHealth {
  ok: boolean;
  path: string;
  version: string;
  rawVersion: string;
  home?: string;
}

export class BridgeError extends Error {
  constructor(
    message: string,
    readonly code: 'AUTH' | 'UNREACHABLE' | 'HTTP' | 'INVALID'
  ) {
    super(message);
    this.name = 'BridgeError';
  }
}

export const DEFAULT_BRIDGE_URL = 'http://127.0.0.1:8768';

type ProcessState = 'idle' | 'starting' | 'running' | 'exited' | 'failed';

const UNKNOWN_EXIT_CODE = -1;
const TIMEOUT_EXIT_CODE = 124;

let configuredBridgeUrl: string | undefined;
let configuredBridgeToken: string | undefined;

function toError(err: unknown): Error {
  return err instanceof Error ? err : new Error(String(err));
}

function normalizeBridgeUrl(url?: string): string {
  const trimmed = (url ?? '').trim().replace(/\/+$/, '');
  return trimmed || DEFAULT_BRIDGE_URL;
}

/**
 * Updates the active Termux bridge URL and authentication token used by HTTP requests.
 */
export function configureBridge(url?: string, token?: string): void {
  if (url !== undefined) {
    configuredBridgeUrl = normalizeBridgeUrl(url);
  }
  if (token !== undefined) {
    configuredBridgeToken = token.trim();
  }
}

/**
 * Returns the active Termux bridge URL and token, falling back to Acode plugin settings.
 */
export function getBridgeConfig(): { url: string; token: string } {
  let settingsUrl: string | undefined;
  let settingsToken: string | undefined;

  if (typeof acode !== 'undefined' && typeof acode.require === 'function') {
    try {
      const appSettings = acode.require('settings');
      const vcgit = appSettings?.get?.('vcgit') as { bridgeUrl?: string; bridgeToken?: string } | undefined;
      settingsUrl = vcgit?.bridgeUrl;
      settingsToken = vcgit?.bridgeToken;
    } catch {
      // Settings module may not be ready yet during early evaluation.
    }
  }

  return {
    url: normalizeBridgeUrl(configuredBridgeUrl ?? settingsUrl),
    token: (configuredBridgeToken ?? settingsToken ?? '').trim(),
  };
}

/**
 * Decodes a base64 payload into raw bytes, preserving null bytes and binary data.
 */
export function decodeBase64ToBytes(base64: string): Uint8Array {
  if (!base64) {
    return new Uint8Array(0);
  }

  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

function decodeBase64ToString(base64: string): string {
  const bytes = decodeBase64ToBytes(base64);
  if (bytes.length === 0) {
    return '';
  }
  return new TextDecoder('utf-8', { fatal: false }).decode(bytes);
}

function encodeStringToBase64(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = '';
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

function buildBridgeArgs(args: readonly string[], options: SpawnOptions): string[] {
  const finalArgs = [...args];
  if (options.shellAppend === '/dev/null') {
    finalArgs.push('/dev/null');
  }
  return finalArgs;
}

/**
 * Queries `GET /health` on the Termux Git Bridge and verifies authentication and git availability.
 */
export async function checkBridgeHealth(): Promise<BridgeHealth> {
  const { url, token } = getBridgeConfig();
  if (!token) {
    throw new BridgeError('Termux Bridge Token is not configured.', 'AUTH');
  }

  let response: Response;
  try {
    response = await fetch(`${url}/health`, {
      method: 'GET',
      headers: {
        'X-Bridge-Token': token,
      },
    });
  } catch (err) {
    throw new BridgeError(`Unable to reach Termux Git Bridge at ${url}: ${toError(err).message}`, 'UNREACHABLE');
  }

  if (response.status === 401 || response.status === 403) {
    throw new BridgeError('Termux Bridge authentication failed (invalid X-Bridge-Token).', 'AUTH');
  }

  if (!response.ok) {
    throw new BridgeError(`Termux Bridge health check failed with HTTP ${response.status}.`, 'HTTP');
  }

  const payload = await response.json() as {
    ok?: boolean;
    git?: string;
    version?: string;
    gitPath?: string;
    home?: string;
  };

  if (!payload || payload.ok !== true) {
    throw new BridgeError('Termux Bridge returned an unhealthy status.', 'INVALID');
  }

  const rawVersion = (payload.git ?? '').trim();
  const version = (payload.version ?? rawVersion.replace(/^git version\s+/i, '')).trim();
  return {
    ok: true,
    path: payload.gitPath || '/data/data/com.termux/files/usr/bin/git',
    version,
    rawVersion,
    home: payload.home,
  };
}

async function callBridgeGit(
  args: readonly string[],
  options: SpawnOptions = {},
  stdinText?: string,
  signal?: AbortSignal
): Promise<ExecResult> {
  const { url, token } = getBridgeConfig();
  if (!token) {
    throw new BridgeError('Termux Bridge Token is not configured.', 'AUTH');
  }

  const body: {
    args: string[];
    cwd?: string;
    stdinBase64?: string;
    env?: Record<string, string>;
  } = {
    args: buildBridgeArgs(args, options),
  };

  if (options.cwd) {
    body.cwd = options.cwd;
  }
  if (options.env && Object.keys(options.env).length > 0) {
    body.env = options.env;
  }
  if (stdinText !== undefined && stdinText.length > 0) {
    body.stdinBase64 = encodeStringToBase64(stdinText);
  }

  let response: Response;
  try {
    response = await fetch(`${url}/git`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Bridge-Token': token,
      },
      body: JSON.stringify(body),
      signal,
    });
  } catch (err) {
    throw new BridgeError(`Failed to connect to Termux Git Bridge at ${url}: ${toError(err).message}`, 'UNREACHABLE');
  }

  if (response.status === 401 || response.status === 403) {
    throw new BridgeError('Termux Bridge authentication failed (invalid X-Bridge-Token).', 'AUTH');
  }

  if (!response.ok) {
    let errorDetail = `HTTP ${response.status}`;
    try {
      const errJson = await response.json() as { error?: string };
      if (errJson?.error) {
        errorDetail = errJson.error;
      }
    } catch {
      // Ignore non-JSON error bodies.
    }
    throw new BridgeError(`Termux Bridge error: ${errorDetail}`, 'HTTP');
  }

  const data = await response.json() as {
    stdoutBase64?: string;
    stderrBase64?: string;
    exitCode?: number;
  };

  const stdoutBytes = decodeBase64ToBytes(data.stdoutBase64 ?? '');
  const stderrBytes = decodeBase64ToBytes(data.stderrBase64 ?? '');
  const decoder = new TextDecoder('utf-8', { fatal: false });

  return {
    stdout: decoder.decode(stdoutBytes),
    stderr: decoder.decode(stderrBytes),
    exitCode: typeof data.exitCode === 'number' ? data.exitCode : UNKNOWN_EXIT_CODE,
    stdoutBytes,
    stderrBytes,
  };
}

class ProcessEmitter {
  private readonly listeners = new Map<ProcessEvent, Set<ProcessListener<any>>>();

  on<E extends ProcessEvent>(event: E, listener: ProcessListener<E>): void {
    let set = this.listeners.get(event);
    if (!set) {
      set = new Set();
      this.listeners.set(event, set);
    }
    set.add(listener);
  }

  off<E extends ProcessEvent>(event: E, listener: ProcessListener<E>): void {
    this.listeners.get(event)?.delete(listener);
  }

  hasListeners(event: ProcessEvent): boolean {
    return (this.listeners.get(event)?.size ?? 0) > 0;
  }

  emit<E extends ProcessEvent>(event: E, payload: ProcessEventMap[E]): void {
    const set = this.listeners.get(event);
    if (!set) return;

    // Copy so listeners may safely unsubscribe while being notified.
    for (const listener of [...set]) {
      try {
        listener(payload);
      } catch (err) {
        console.warn(`Error in '${event}' listener:`, err);
      }
    }
  }

  clear(): void {
    this.listeners.clear();
  }
}

export class WritableProcessStream {
  constructor(private readonly process: Process) { }

  write(data: string): Promise<void> {
    return this.process.write(data);
  }
}

export class ReadableProcessStream {
  constructor(
    private readonly process: Process,
    private readonly type: 'stdout' | 'stderr'
  ) { }

  on(event: 'data', listener: (data: string) => void): void;
  on(event: 'close', listener: (code: number) => void): void;
  on(event: 'data' | 'close', listener: (payload: any) => void): void {
    this.process.on(event === 'data' ? this.type : 'close', listener);
  }

  off(event: 'data', listener: (data: string) => void): void;
  off(event: 'close', listener: (code: number) => void): void;
  off(event: 'data' | 'close', listener: (payload: any) => void): void {
    this.process.off(event === 'data' ? this.type : 'close', listener);
  }
}

class BridgeProcess implements Process {
  readonly stdin: WritableProcessStream = new WritableProcessStream(this);
  readonly stdout: ReadableProcessStream = new ReadableProcessStream(this, 'stdout');
  readonly stderr: ReadableProcessStream = new ReadableProcessStream(this, 'stderr');

  private readonly emitter = new ProcessEmitter();
  private readonly abortController = new AbortController();

  private state: ProcessState = 'idle';
  private killRequested = false;
  private stdinChunks: string[] = [];
  private _pid: string | null = null;
  private _exitCode: number | null = null;

  constructor(
    private readonly _command: string,
    private readonly args: readonly string[],
    private readonly options: SpawnOptions = {}
  ) { }

  get pid(): string | null {
    return this._pid;
  }

  get exitCode(): number | null {
    return this._exitCode;
  }

  on<E extends ProcessEvent>(event: E, listener: ProcessListener<E>): void {
    this.emitter.on(event, listener);
  }

  off<E extends ProcessEvent>(event: E, listener: ProcessListener<E>): void {
    this.emitter.off(event, listener);
  }

  async start(): Promise<void> {
    if (this.state !== 'idle') return;
    if (this.killRequested) {
      this.handleExit(UNKNOWN_EXIT_CODE);
      return;
    }

    this.state = 'running';
    this._pid = `bridge-${Date.now()}`;
    const stdinText = this.stdinChunks.length > 0 ? this.stdinChunks.join('') : undefined;
    this.stdinChunks = [];

    try {
      const result = await callBridgeGit(this.args, this.options, stdinText, this.abortController.signal);
      if (this.killRequested || this.state !== 'running') {
        return;
      }

      if (result.stdout.length > 0) {
        this.emitter.emit('stdout', result.stdout);
        this.emitter.emit('data', result.stdout);
      }

      if (result.stderr.length > 0) {
        this.emitter.emit('stderr', result.stderr);
        this.emitter.emit('data', result.stderr);
      }

      this.handleExit(result.exitCode);
    } catch (err) {
      if (this.killRequested) {
        this.handleExit(UNKNOWN_EXIT_CODE);
        return;
      }

      const error = toError(err);
      this.state = 'failed';
      this._exitCode = UNKNOWN_EXIT_CODE;

      if (this.emitter.hasListeners('error')) {
        this.emitter.emit('error', error);
      } else {
        this.emitter.emit('stderr', error.message);
        this.emitter.emit('data', error.message);
      }

      this.emitter.emit('close', UNKNOWN_EXIT_CODE);
      this.emitter.clear();
    }
  }

  async write(data: string): Promise<void> {
    if (this.state !== 'idle') {
      throw new Error('Process stdin is already closed');
    }
    this.stdinChunks.push(data);
  }

  async kill(): Promise<void> {
    this.killRequested = true;
    this.abortController.abort();
    if (this.state === 'running') {
      this.handleExit(UNKNOWN_EXIT_CODE);
    }
  }

  async isRunning(): Promise<boolean> {
    return this.state === 'starting' || this.state === 'running';
  }

  private handleExit(code: number): void {
    if (this.state === 'exited') return;

    this.state = 'exited';
    this._exitCode = code;
    this.emitter.emit('close', code);
    this.emitter.clear();
  }
}

export function spawn(command: string, args: string[] = [], options: SpawnOptions = {}): Process {
  const proc = new BridgeProcess(command, args, options);
  // Defer HTTP execution one microtask so callers can attach listeners synchronously first.
  queueMicrotask(() => {
    void proc.start();
  });
  return proc;
}

export async function exec(command: string, args: string[] = [], options: ExecOptions = {}): Promise<ExecResult> {
  void command;
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let timedOut = false;

  if (options.timeout && options.timeout > 0) {
    timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, options.timeout);
  }

  try {
    return await callBridgeGit(args, options, undefined, controller.signal);
  } catch (err) {
    if (timedOut) {
      return {
        exitCode: TIMEOUT_EXIT_CODE,
        stdout: '',
        stderr: `Command timed out after ${options.timeout}ms`,
      };
    }

    return {
      exitCode: UNKNOWN_EXIT_CODE,
      stdout: '',
      stderr: toError(err).message,
    };
  } finally {
    clearTimeout(timer);
  }
}
