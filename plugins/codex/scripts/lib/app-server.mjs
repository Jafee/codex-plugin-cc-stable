/**
 * @typedef {Error & { data?: unknown, rpcCode?: number }} ProtocolError
 * @typedef {import("./app-server-protocol").AppServerMethod} AppServerMethod
 * @typedef {import("./app-server-protocol").AppServerNotification} AppServerNotification
 * @typedef {import("./app-server-protocol").AppServerNotificationHandler} AppServerNotificationHandler
 * @typedef {import("./app-server-protocol").ClientInfo} ClientInfo
 * @typedef {import("./app-server-protocol").CodexAppServerClientOptions} CodexAppServerClientOptions
 * @typedef {import("./app-server-protocol").InitializeCapabilities} InitializeCapabilities
 */
import fs from "node:fs";
import net from "node:net";
import process from "node:process";
import { spawn } from "node:child_process";
import readline from "node:readline";
import { parseBrokerEndpoint } from "./broker-endpoint.mjs";
import { ensureBrokerSession, loadBrokerSession } from "./broker-lifecycle.mjs";
import { terminateProcessTree } from "./process.mjs";

const PLUGIN_MANIFEST_URL = new URL("../../.claude-plugin/plugin.json", import.meta.url);
const PLUGIN_MANIFEST = JSON.parse(fs.readFileSync(PLUGIN_MANIFEST_URL, "utf8"));

export const BROKER_ENDPOINT_ENV = "CODEX_COMPANION_APP_SERVER_ENDPOINT";
export const BROKER_BUSY_RPC_CODE = -32001;

const DEFAULT_RPC_TIMEOUT_MS = 30_000;
// Node's timers overflow for delays above 2^31-1 ms (~24.8 days) and silently
// fire them after ~1ms instead. Clamp every env-derived timeout to this ceiling
// so an over-large value can't turn a long timeout into an immediate one.
const MAX_TIMER_MS = 2_147_483_647;
// Upper bound on connect()'s post-failure cleanup so a hung close() (a wedged
// app-server ignoring SIGTERM, or a broker client that threw before it created a
// socket to await) can never turn a fast failure into an unbounded hang.
const CLEANUP_TIMEOUT_MS = 2_000;

/**
 * Parse a millisecond timeout from an environment variable. Falls back to
 * `defaultMs` for anything non-finite or negative, and clamps huge values to the
 * Node timer ceiling. Unless `allowDisable` is set, an explicit 0 also maps to
 * the default so an unconditional timer is never armed with a 0/immediate delay;
 * with `allowDisable`, 0 is preserved for callers that treat it as "disabled".
 * @param {string} envName
 * @param {number} defaultMs
 * @param {{ allowDisable?: boolean }} [options]
 */
export function resolveTimeoutMs(envName, defaultMs, { allowDisable = false } = {}) {
  const raw = process.env[envName];
  if (raw === undefined || raw === "") {
    return defaultMs;
  }
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return defaultMs;
  }
  if (parsed === 0) {
    return allowDisable ? 0 : defaultMs;
  }
  return Math.min(parsed, MAX_TIMER_MS);
}

/** @type {ClientInfo} */
const DEFAULT_CLIENT_INFO = {
  title: "Codex Plugin",
  name: "Claude Code",
  version: PLUGIN_MANIFEST.version ?? "0.0.0"
};

/** @type {InitializeCapabilities} */
const DEFAULT_CAPABILITIES = {
  experimentalApi: false,
  optOutNotificationMethods: [
    "item/agentMessage/delta",
    "item/reasoning/summaryTextDelta",
    "item/reasoning/summaryPartAdded",
    "item/reasoning/textDelta"
  ]
};

function buildJsonRpcError(code, message, data) {
  return data === undefined ? { code, message } : { code, message, data };
}

function createProtocolError(message, data) {
  const error = /** @type {ProtocolError} */ (new Error(message));
  error.data = data;
  if (data?.code !== undefined) {
    error.rpcCode = data.code;
  }
  return error;
}

class AppServerClientBase {
  constructor(cwd, options = {}) {
    this.cwd = cwd;
    this.options = options;
    this.pending = new Map();
    this.nextId = 1;
    this.stderr = "";
    this.closed = false;
    this.exitError = null;
    /** @type {AppServerNotificationHandler | null} */
    this.notificationHandler = null;
    this.lineBuffer = "";
    this.transport = "unknown";

    this.exitPromise = new Promise((resolve) => {
      this.resolveExit = resolve;
    });
  }

  setNotificationHandler(handler) {
    this.notificationHandler = handler;
  }

  /**
   * @template {AppServerMethod} M
   * @param {M} method
   * @param {import("./app-server-protocol").AppServerRequestParams<M>} params
   * @returns {Promise<import("./app-server-protocol").AppServerResponse<M>>}
   */
  request(method, params) {
    if (this.closed) {
      throw new Error("codex app-server client is closed.");
    }

    const id = this.nextId;
    this.nextId += 1;

    return new Promise((resolve, reject) => {
      const timeoutMs = resolveTimeoutMs("CODEX_APP_SERVER_RPC_TIMEOUT_MS", DEFAULT_RPC_TIMEOUT_MS, {
        allowDisable: true
      });
      let timer = null;
      const wrappedResolve = (value) => {
        if (timer) clearTimeout(timer);
        resolve(value);
      };
      const wrappedReject = (err) => {
        if (timer) clearTimeout(timer);
        reject(err);
      };
      if (timeoutMs > 0) {
        timer = setTimeout(() => {
          if (this.pending.get(id)?.reject === wrappedReject) {
            this.pending.delete(id);
          }
          reject(new Error(`codex app-server ${method} request timed out after ${timeoutMs}ms`));
        }, timeoutMs);
        timer.unref?.();
      }
      this.pending.set(id, { resolve: wrappedResolve, reject: wrappedReject, method });
      this.sendMessage({ id, method, params });
    });
  }

  notify(method, params = {}) {
    if (this.closed) {
      return;
    }
    this.sendMessage({ method, params });
  }

  handleChunk(chunk) {
    this.lineBuffer += chunk;
    let newlineIndex = this.lineBuffer.indexOf("\n");
    while (newlineIndex !== -1) {
      const line = this.lineBuffer.slice(0, newlineIndex);
      this.lineBuffer = this.lineBuffer.slice(newlineIndex + 1);
      this.handleLine(line);
      newlineIndex = this.lineBuffer.indexOf("\n");
    }
  }

  handleLine(line) {
    if (!line.trim()) {
      return;
    }

    let message;
    try {
      message = JSON.parse(line);
    } catch (error) {
      this.handleExit(createProtocolError(`Failed to parse codex app-server JSONL: ${error.message}`, { line }));
      return;
    }

    if (message.id !== undefined && message.method) {
      this.handleServerRequest(message);
      return;
    }

    if (message.id !== undefined) {
      const pending = this.pending.get(message.id);
      if (!pending) {
        return;
      }
      this.pending.delete(message.id);

      if (message.error) {
        pending.reject(createProtocolError(message.error.message ?? `codex app-server ${pending.method} failed.`, message.error));
      } else {
        pending.resolve(message.result ?? {});
      }
      return;
    }

    if (message.method && this.notificationHandler) {
      this.notificationHandler(/** @type {AppServerNotification} */ (message));
    }
  }

  handleServerRequest(message) {
    this.sendMessage({
      id: message.id,
      error: buildJsonRpcError(-32601, `Unsupported server request: ${message.method}`)
    });
  }

  handleExit(error) {
    if (this.exitResolved) {
      return;
    }

    this.exitResolved = true;
    this.exitError = error ?? null;

    for (const pending of this.pending.values()) {
      pending.reject(this.exitError ?? new Error("codex app-server connection closed."));
    }
    this.pending.clear();
    this.resolveExit(undefined);
  }

  sendMessage(_message) {
    throw new Error("sendMessage must be implemented by subclasses.");
  }
}

class SpawnedCodexAppServerClient extends AppServerClientBase {
  constructor(cwd, options = {}) {
    super(cwd, options);
    this.transport = "direct";
  }

  async initialize() {
    this.proc = spawn("codex", ["app-server"], {
      cwd: this.cwd,
      env: this.options.env ?? process.env,
      stdio: ["pipe", "pipe", "pipe"],
      shell: process.platform === "win32" ? (process.env.SHELL || true) : false,
      windowsHide: true
    });

    this.proc.stdout.setEncoding("utf8");
    this.proc.stderr.setEncoding("utf8");

    this.proc.stderr.on("data", (chunk) => {
      this.stderr += chunk;
    });

    this.proc.on("error", (error) => {
      this.handleExit(error);
    });

    this.proc.on("exit", (code, signal) => {
      const detail =
        code === 0
          ? null
          : createProtocolError(`codex app-server exited unexpectedly (${signal ? `signal ${signal}` : `exit ${code}`}).`);
      this.handleExit(detail);
    });

    this.readline = readline.createInterface({ input: this.proc.stdout });
    this.readline.on("line", (line) => {
      this.handleLine(line);
    });

    await this.request("initialize", {
      clientInfo: this.options.clientInfo ?? DEFAULT_CLIENT_INFO,
      capabilities: this.options.capabilities ?? DEFAULT_CAPABILITIES
    });
    this.notify("initialized", {});
  }

  async close() {
    if (this.closed) {
      await this.exitPromise;
      return;
    }

    this.closed = true;

    if (this.readline) {
      this.readline.close();
    }

    if (this.proc && !this.proc.killed) {
      this.proc.stdin.end();
      setTimeout(() => {
        if (this.proc && !this.proc.killed && this.proc.exitCode === null) {
          // On Windows with shell: true, the direct child is cmd.exe.
          // Use terminateProcessTree to kill the entire tree including
          // the grandchild node process.
          if (process.platform === "win32") {
            try {
              terminateProcessTree(this.proc.pid);
            } catch {
              // Best-effort cleanup inside an unref'd timer — swallow errors
              // to avoid crashing the host process during shutdown.
            }
          } else {
            this.proc.kill("SIGTERM");
          }
        }
      }, 50).unref?.();
      // If SIGTERM did not land — a wedged app-server (the kind that made
      // initialize time out) can ignore it — escalate to an uncatchable kill so
      // its still-open stdio pipes cannot keep this process alive after a failed
      // connect or teardown. Without this, connect()'s caller can reject yet the
      // host process still never exits. (Reviewer P2, round 2.)
      setTimeout(() => {
        // Do NOT gate on `!this.proc.killed`: Node sets `killed` once any signal
        // has been *sent* (the SIGTERM above), even if the process ignored it.
        // `exitCode === null && signalCode === null` is the real "still running"
        // check (a SIGTERM-terminated proc has exitCode null but signalCode set).
        if (this.proc && this.proc.exitCode === null && this.proc.signalCode === null) {
          try {
            if (process.platform === "win32") {
              terminateProcessTree(this.proc.pid);
            } else {
              this.proc.kill("SIGKILL");
            }
          } catch {
            // Best-effort cleanup inside an unref'd timer.
          }
        }
      }, 1000).unref?.();
    }

    await this.exitPromise;
    // The child has exited, but a descendant that inherited its stdout/stderr can
    // still hold the pipe write ends and keep our read streams — and thus this
    // process's event loop — alive. Destroy our ends so the host can exit even
    // when a grandchild lingers. (Reviewer P2, round 3.)
    this.proc?.stdout?.destroy();
    this.proc?.stderr?.destroy();
  }

  sendMessage(message) {
    const line = `${JSON.stringify(message)}\n`;
    const stdin = this.proc?.stdin;
    if (!stdin) {
      throw new Error("codex app-server stdin is not available.");
    }
    stdin.write(line);
  }
}

class BrokerCodexAppServerClient extends AppServerClientBase {
  constructor(cwd, options = {}) {
    super(cwd, options);
    this.transport = "broker";
    this.endpoint = options.brokerEndpoint;
  }

  async initialize() {
    await new Promise((resolve, reject) => {
      const target = parseBrokerEndpoint(this.endpoint);
      this.socket = net.createConnection({ path: target.path });
      this.socket.setEncoding("utf8");
      this.socket.on("connect", resolve);
      this.socket.on("data", (chunk) => {
        this.handleChunk(chunk);
      });
      this.socket.on("error", (error) => {
        if (!this.exitResolved) {
          reject(error);
        }
        this.handleExit(error);
      });
      this.socket.on("close", () => {
        this.handleExit(this.exitError);
      });
    });

    await this.request("initialize", {
      clientInfo: this.options.clientInfo ?? DEFAULT_CLIENT_INFO,
      capabilities: this.options.capabilities ?? DEFAULT_CAPABILITIES
    });
    this.notify("initialized", {});
  }

  async close() {
    if (this.closed) {
      await this.exitPromise;
      return;
    }

    this.closed = true;
    if (this.socket) {
      this.socket.end();
    }
    await this.exitPromise;
  }

  sendMessage(message) {
    const line = `${JSON.stringify(message)}\n`;
    const socket = this.socket;
    if (!socket) {
      throw new Error("codex app-server broker connection is not connected.");
    }
    socket.write(line);
  }
}

export class CodexAppServerClient {
  static async connect(cwd, options = {}) {
    let brokerEndpoint = null;
    if (!options.disableBroker) {
      brokerEndpoint = options.brokerEndpoint ?? options.env?.[BROKER_ENDPOINT_ENV] ?? process.env[BROKER_ENDPOINT_ENV] ?? null;
      if (!brokerEndpoint && options.reuseExistingBroker) {
        brokerEndpoint = loadBrokerSession(cwd)?.endpoint ?? null;
      }
      if (!brokerEndpoint && !options.reuseExistingBroker) {
        const brokerSession = await ensureBrokerSession(cwd, { env: options.env });
        brokerEndpoint = brokerSession?.endpoint ?? null;
      }
    }
    const client = brokerEndpoint
      ? new BrokerCodexAppServerClient(cwd, { ...options, brokerEndpoint })
      : new SpawnedCodexAppServerClient(cwd, options);
    try {
      await client.initialize();
    } catch (error) {
      // initialize() may already have spawned the direct app-server (or opened
      // the broker socket) before failing — e.g. the initialize RPC hit its
      // wall-clock timeout. The caller never receives `client`, so close it here
      // or the spawned process/socket is orphaned. (Reviewer P2.)
      //
      // But close() awaits process/socket teardown and can itself hang: the
      // wedged app-server that made initialize time out may also ignore SIGTERM,
      // and a broker client that threw before creating its socket has no exit
      // event to ever resolve exitPromise. Bound the cleanup so a fast failure
      // can never become a hang, and rethrow the original error regardless.
      await Promise.race([
        client.close().catch(() => {}),
        new Promise((resolve) => {
          const timer = setTimeout(resolve, CLEANUP_TIMEOUT_MS);
          timer.unref?.();
        })
      ]);
      throw error;
    }
    return client;
  }
}
