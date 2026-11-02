import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { setTimeout as wait } from "node:timers/promises";
import type { SiteConfig } from "./config.ts";
import { runShell } from "./shell.ts";

/** How long the Site's build command may run. */
const BUILD_TIMEOUT_MS = 15 * 60 * 1000;
const POLL_MS = 100;
/** How long a stopped server gets before it is killed. */
const STOP_GRACE_MS = 2000;
const OUTPUT_TAIL_LINES = 15;

/** Why the build could not be served, in plain words; it counts as the Ticket's failure. */
export class ServeError extends Error {}

/**
 * Builds the Site in `worktree` with its build command, serves it with its serve
 * command on a free port, hands the address to `use`, and stops the server with
 * everything it started. The port reaches the command as `{port}` and as `PORT`,
 * since a fixed port could be held by something else, and then the Review checks
 * would measure that instead of the Ticket's build.
 */
export async function withServedBuild<T>(worktree: string, config: SiteConfig, use: (url: URL) => Promise<T>): Promise<T> {
  if (config.buildCommand) await build(worktree, config.buildCommand);
  const port = await freePort();
  const command = config.serveCommand!.replaceAll("{port}", String(port));
  const child = spawn("sh", ["-c", command], {
    cwd: worktree,
    env: { ...process.env, PORT: String(port) },
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
  });
  let output = "";
  let spawnError: string | undefined;
  child.stdout.on("data", (chunk: Buffer) => (output += chunk.toString()));
  child.stderr.on("data", (chunk: Buffer) => (output += chunk.toString()));
  const closed = new Promise<void>((resolve) => {
    child.on("error", (error) => ((spawnError = error.message), resolve()));
    child.on("close", () => resolve());
  });
  let running = true;
  void closed.then(() => (running = false));

  const url = new URL(`http://localhost:${port}/`);
  try {
    const deadline = Date.now() + config.serveTimeoutMs;
    while (!(await answers(url))) {
      if (!running) {
        throw new ServeError(`The Site's serve command \`${command}\` stopped before the Site answered${spawnError ? ` (${spawnError})` : ""}.${printed(output)}`);
      }
      if (Date.now() >= deadline) {
        throw new ServeError(`The Site's serve command \`${command}\` was running, but the Site did not answer at ${url.href} within ${config.serveTimeoutMs / 1000} seconds. It has to listen on {port} or on PORT.${printed(output)}`);
      }
      await wait(POLL_MS);
    }
    return await use(url);
  } finally {
    await stop(child.pid, closed);
  }
}

async function build(worktree: string, command: string): Promise<void> {
  const run = await runShell(worktree, command, BUILD_TIMEOUT_MS);
  if (run.timedOut) {
    throw new ServeError(`The Site's build command \`${command}\` did not finish within ${BUILD_TIMEOUT_MS / 60_000} minutes, so it was stopped.${printed(run.output)}`);
  }
  if (run.exitCode !== 0) throw new ServeError(`The Site's build command \`${command}\` failed with exit code ${run.exitCode}.${printed(run.output)}`);
}

function printed(output: string): string {
  const tail = output.trimEnd().split("\n").slice(-OUTPUT_TAIL_LINES).join("\n");
  return tail ? ` The last thing it printed:\n${tail}` : "";
}

/** Any answer counts: a page that answers 404 or 500 is for the Review checks to report. */
function answers(url: URL): Promise<boolean> {
  return fetch(url, { redirect: "manual", signal: AbortSignal.timeout(2000) }).then(
    () => true,
    () => false,
  );
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => (address && typeof address === "object" ? resolve(address.port) : reject(new Error("no free port"))));
    });
  });
}

async function stop(pid: number | undefined, closed: Promise<void>): Promise<void> {
  if (pid === undefined) return;
  const signal = (name: NodeJS.Signals) => {
    try {
      process.kill(-pid, name);
    } catch {
      // Already gone.
    }
  };
  signal("SIGTERM");
  await Promise.race([closed, wait(STOP_GRACE_MS)]);
  // The whole group, even when its shell is gone: a server it started may outlive it.
  signal("SIGKILL");
}
