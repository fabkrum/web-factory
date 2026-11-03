/**
 * A stand-in for the Firebase CLI, run as `node fake-firebase.ts <firebase's arguments>`.
 *
 * Like the real one it reads `firebase.json` and `.firebaserc` in its directory, uploads the
 * `public` folder, and answers with one JSON object. What it serves is kept in the folder
 * FAKE_FIREBASE_STATE: one file per URL, named by the URL's encoded form.
 *
 * FAKE_FIREBASE_ERROR makes it answer with that error, as a refused deploy does.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const answer = (json: unknown, code = 0): never => {
  process.stdout.write(`${JSON.stringify(json, null, 2)}\n`);
  process.exit(code);
};

const [command, target, ...rest] = process.argv.slice(2);
if (process.env.FAKE_FIREBASE_ERROR) answer({ status: "error", error: process.env.FAKE_FIREBASE_ERROR }, 1);
if (!process.argv.includes("--json") || !process.argv.includes("--non-interactive")) answer({ status: "error", error: "would have asked a question" }, 1);

const { hosting } = JSON.parse(readFileSync("firebase.json", "utf8")) as { hosting: { public: string; site?: string } };
const project = (JSON.parse(readFileSync(".firebaserc", "utf8")) as { projects: { default: string } }).projects.default;
const site = hosting.site ?? project;
const state = process.env.FAKE_FIREBASE_STATE!;
mkdirSync(state, { recursive: true });
const upload = (url: string) => writeFileSync(join(state, encodeURIComponent(url)), readFileSync(join(hosting.public, "index.html")));

if (command === "hosting:channel:deploy") {
  if (!/^[a-z0-9-]{1,63}$/.test(target ?? "") || rest[0] !== "--expires") answer({ status: "error", error: `Invalid channel: ${target}` }, 1);
  const url = `https://${site}--${target}-abc123.web.app`;
  upload(url);
  answer({ status: "success", result: { [site]: { site, url, version: "v1", expireTime: "2026-12-01T00:00:00Z" } } });
}
if (command === "deploy" && target === "--only" && rest[0] === "hosting") {
  upload(`https://${site}.web.app`);
  answer({ status: "success", result: { hosting: `projects/${project}/sites/${site}/versions/v1` } });
}
answer({ status: "error", error: `Unknown command: ${command}` }, 1);
