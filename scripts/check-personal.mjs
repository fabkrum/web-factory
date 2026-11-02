#!/usr/bin/env node
// Fails when a tracked file holds anything personal, so that any attendee can run the Factory.
// Run it from the root of the repository: node scripts/check-personal.mjs

import { execFileSync } from "node:child_process";
import { lstatSync, readFileSync } from "node:fs";
import { basename } from "node:path";

/** This check and its test have to name what they look for. */
const SELF = new Set(["scripts/check-personal.mjs", "test/check-personal.test.ts"]);

const FORBIDDEN = [
  { what: "the maintainer's name or account", pattern: /fabian|krumbholz|fabkrum/i },
  { what: "a home path", pattern: /\/Users\/[A-Za-z]/ },
  { what: "Speed Kit", pattern: /speed[ _-]?kit/i },
  { what: "an fk: skill", pattern: /\bfk:[a-z]/i },
  { what: "Warp", pattern: /\bwarp\b/i },
  { what: "launchd", pattern: /launchd/i },
  { what: "caffeinate", pattern: /\bcaffeinate\b/i },
  // Only this phrase: WebAuthn's "attestation" in the vendored guidance is something else.
  { what: "the operator attestation", pattern: /operator[ _-]attestation/i },
];

/** The public names the Factory is published under, which are not personal data. */
const PUBLIC_NAMES = [/@fabkrum\/web-factory\b/g, /\bfabkrum\/web-factory\b/g, /\bfabkrum-web-factory\b/g];

/** The licence has to name its copyright holder. */
const COPYRIGHT_LINE = /^Copyright \(c\) \d{4} Fabian Krumbholz$/;

function publicPartsRemoved(line, path) {
  if (basename(path) === "LICENSE" && COPYRIGHT_LINE.test(line)) return "";
  return PUBLIC_NAMES.reduce((text, name) => text.replace(name, ""), line);
}

function findings(path, text) {
  const found = [];
  const check = (line, where) => {
    for (const { what, pattern } of FORBIDDEN) {
      if (pattern.test(publicPartsRemoved(line, path))) found.push(`${where}: ${what}`);
    }
  };
  check(path, path);
  text?.split("\n").forEach((line, index) => check(line, `${path}:${index + 1}`));
  return found;
}

function readText(path) {
  try {
    if (!lstatSync(path).isFile()) return undefined;
    const content = readFileSync(path);
    return content.includes(0) ? undefined : content.toString("utf8");
  } catch {
    return undefined;
  }
}

const tracked = execFileSync("git", ["ls-files", "-z"], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }).split("\0").filter(Boolean);
const found = tracked.filter((path) => !SELF.has(path)).flatMap((path) => findings(path, readText(path)));

if (found.length > 0) {
  console.error(`The Factory has to be free of anything personal, and ${found.length} place(s) are not:`);
  for (const finding of found) console.error(`  ${finding}`);
  process.exitCode = 1;
} else {
  console.log(`Nothing personal in ${tracked.length} tracked files.`);
}
