import { spawn } from "node:child_process";

export interface ShellResult {
  exitCode: number;
  /** What the command printed, stdout and stderr interleaved. */
  output: string;
  /** True when the command ran past its time limit and was stopped. */
  timedOut: boolean;
}

/**
 * Runs one command with `sh -c` in `cwd`. Given `timeoutMs`, it stops the
 * command after that long, with everything it started (a test runner, a server).
 */
export function runShell(cwd: string, command: string, timeoutMs?: number): Promise<ShellResult> {
  return new Promise((resolve, reject) => {
    // Its own process group, so a time limit stops the command's children too.
    const child = spawn("sh", ["-c", command], { cwd, stdio: ["ignore", "pipe", "pipe"], detached: timeoutMs !== undefined });
    let output = "";
    let timedOut = false;
    const timer =
      timeoutMs === undefined
        ? undefined
        : setTimeout(() => {
            timedOut = true;
            try {
              process.kill(-child.pid!, "SIGKILL");
            } catch {
              child.kill("SIGKILL");
            }
          }, timeoutMs);
    child.stdout.on("data", (chunk: Buffer) => (output += chunk.toString()));
    child.stderr.on("data", (chunk: Buffer) => (output += chunk.toString()));
    child.on("error", (error) => (clearTimeout(timer), reject(error)));
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      resolve({ exitCode: code ?? (signal ? 128 : 1), output, timedOut });
    });
  });
}
