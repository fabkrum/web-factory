import { spawn } from "node:child_process";

/** How long a session gets to stop after its time limit before it is killed. */
const KILL_GRACE_MS = 5000;

export type ProcessRun = { code: number; stdout: string; stderr: string } | { failure: string };

/**
 * Runs one Agent CLI session as a process: the prompt on stdin, its output collected.
 * A missing command or a session past its time limit comes back as a failure in plain
 * words, never as a thrown error.
 */
export function runSessionProcess(options: {
  command: string[];
  cwd: string;
  env: Record<string, string>;
  input: string;
  timeoutMs: number;
  /** The Agent CLI's name and its command's usual name, for the reasons a session failed. */
  cli: string;
  commandName: string;
}): Promise<ProcessRun> {
  const [command, ...args] = options.command;
  return new Promise((done) => {
    // Its own process group, so a session that runs out of time is stopped with everything it started.
    const child = spawn(command!, args, {
      cwd: options.cwd,
      env: { ...process.env, ...options.env, GIT_TERMINAL_PROMPT: "0" },
      stdio: ["pipe", "pipe", "pipe"],
      detached: true,
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const stop = (signal: NodeJS.Signals) => {
      try {
        process.kill(-child.pid!, signal);
      } catch {
        // Already gone.
      }
    };
    const timer = setTimeout(() => {
      timedOut = true;
      stop("SIGTERM");
      setTimeout(() => stop("SIGKILL"), KILL_GRACE_MS).unref();
    }, options.timeoutMs);
    child.stdout.on("data", (chunk: Buffer) => (stdout += chunk));
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk));
    child.on("error", (error: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      done({
        failure:
          error.code === "ENOENT"
            ? `${options.cli} (the ${options.commandName} command) is not installed, so the Ticket loop cannot run a session with it.`
            : `${options.cli} could not start: ${error.message}`,
      });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (timedOut) {
        const minutes = Math.round(options.timeoutMs / 60_000);
        const limit = minutes >= 1 ? `${minutes} minute${minutes === 1 ? "" : "s"}` : `${Math.round(options.timeoutMs / 1000)} seconds`;
        done({ failure: `The session ran past its time limit of ${limit} and was stopped.` });
      } else {
        done({ code: code ?? 1, stdout, stderr });
      }
    });
    child.stdin.on("error", () => {});
    child.stdin.end(options.input);
  });
}

/** The first few lines of an error, short enough for a park reason. */
export function firstLines(text: string): string {
  return text.split("\n").slice(0, 5).join("\n").slice(0, 500);
}
