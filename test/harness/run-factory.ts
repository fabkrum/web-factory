import { factory } from "../../src/cli.ts";

export interface FactoryRun {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/** Runs the real `factory` command in a directory, capturing what it prints. */
export async function runFactory(argv: string[], options: { cwd: string }): Promise<FactoryRun> {
  let stdout = "";
  let stderr = "";
  const exitCode = await factory(argv, {
    cwd: options.cwd,
    stdout: (text) => void (stdout += text),
    stderr: (text) => void (stderr += text),
  });
  return { exitCode, stdout, stderr };
}
