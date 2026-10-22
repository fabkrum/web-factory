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

Exit codes: 0 the Site Passes, 1 it did not pass, 2 wrong usage,
3 the review could not run (the Site could not be opened or the review stopped).
`;

/** The review could not measure the Site at all: neither a Pass nor a fail, so it gets a code of its own. */
const COULD_NOT_RUN = 3;

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
    deps.stderr(`${couldNotRun(error)}\n`);
    return COULD_NOT_RUN;
  }
}

/** One plain-language reason the review could not run, with no stack trace. */
function couldNotRun(error: unknown): string {
  if (error instanceof ReviewError) return error.message;
  const detail = (error instanceof Error ? error.message : String(error)).split("\n")[0];
  return `The review stopped before it could check your whole Site (${detail}). Check that your Site is still being served, then run the review again.`;
}

function webAddress(text: string): URL | undefined {
  try {
    const url = new URL(text);
    return url.protocol === "http:" || url.protocol === "https:" ? url : undefined;
  } catch {
    return undefined;
  }
}
