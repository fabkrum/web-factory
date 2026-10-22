import { ReviewError } from "./review/check.ts";
import { formatReport } from "./review/report.ts";
import { runReview } from "./review/review.ts";

export interface FactoryDeps {
  cwd: string;
  stdout: (text: string) => void;
  stderr: (text: string) => void;
}

export const USAGE = `Usage:
  factory review <url> [--json]   Run every Review check on the Site served at <url>
  factory --help                  Show this help
`;

/** The `factory` command. Returns its exit code. */
export async function factory(argv: string[], deps: FactoryDeps): Promise<number> {
  const [command, ...args] = argv;
  if (command === undefined) {
    deps.stderr(USAGE);
    return 2;
  }
  if (command === "--help" || command === "-h" || command === "help") {
    deps.stdout(USAGE);
    return 0;
  }
  if (command !== "review") {
    deps.stderr(`factory does not know the command "${command}".\n\n${USAGE}`);
    return 2;
  }
  return review(args, deps);
}

async function review(args: string[], deps: FactoryDeps): Promise<number> {
  const json = args.includes("--json");
  const rest = args.filter((arg) => arg !== "--json");
  const url = rest.length === 1 ? webAddress(rest[0]!) : undefined;
  if (!url) {
    deps.stderr(
      `factory review needs the full web address of a served Site, starting with http:// or https://, for example: factory review http://localhost:4321\n\n${USAGE}`,
    );
    return 2;
  }
  try {
    const report = await runReview(url);
    deps.stdout(json ? `${JSON.stringify(report, null, 2)}\n` : formatReport(report));
    return report.passed ? 0 : 1;
  } catch (error) {
    if (error instanceof ReviewError) {
      deps.stderr(`${error.message}\n`);
      return 1;
    }
    throw error;
  }
}

function webAddress(text: string): URL | undefined {
  try {
    const url = new URL(text);
    return url.protocol === "http:" || url.protocol === "https:" ? url : undefined;
  } catch {
    return undefined;
  }
}
