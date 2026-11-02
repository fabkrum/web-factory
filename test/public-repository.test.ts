import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const REPOSITORY = resolve(import.meta.dirname, "..");
const read = (path: string) => readFileSync(join(REPOSITORY, path), "utf8");

describe("the README", () => {
  const readme = read("README.md");

  it("says native Windows is not supported in v1", () => {
    expect(readme).toContain("Native Windows is not supported in v1");
  });

  it("explains in one paragraph when to choose the Codespace and when the local install", () => {
    const paragraph = readme.split("\n\n").find((text) => text.includes("Choose the Codespace"));
    expect(paragraph).toContain("Choose the local install");
    expect(paragraph).toContain("overnight");
  });

  it("has a dated cost table with every supported Agent CLI", () => {
    const start = readme.indexOf("### What each Agent CLI costs");
    const section = readme.slice(start, readme.indexOf("\n## ", start));
    expect(section).toMatch(/As of \d{4}-\d{2}-\d{2}/);
    for (const cli of ["Antigravity CLI", "Gemini CLI", "Codex", "Claude Code"]) expect(section).toMatch(new RegExp(`^\\| ${cli} \\|`, "m"));
  });
});

describe("the Codespaces template", () => {
  const container = JSON.parse(read("packages/create-web-factory/template/.devcontainer/devcontainer.json")) as { build: { dockerfile: string }; forwardPorts: number[]; postCreateCommand: string };

  it("forwards the board's port and installs the Site by itself", () => {
    expect(container.forwardPorts).toContain(4400);
    expect(container.postCreateCommand).toContain("npm install");
  });

  it("has every Agent CLI installed, since the Builder picks one later", () => {
    const image = read(`packages/create-web-factory/template/.devcontainer/${container.build.dockerfile}`);
    for (const cli of ["@anthropic-ai/claude-code", "@openai/codex", "@google/gemini-cli", "antigravity.google/cli/install.sh"]) expect(image).toContain(cli);
  });
});

describe("the Factory repository", () => {
  it("has a bug report template asking what a workshop attendee can answer", () => {
    const template = read(".github/ISSUE_TEMPLATE/bug_report.yml");
    expect(template).toMatch(/^name: Bug report$/m);
    expect(template).toMatch(/^description: \S/m);
    for (const label of ["What happened?", "How do you run the Factory?", "Which Agent CLI do you use?"]) expect(template).toContain(label);
  });

  it("runs the two ways in and the personal check in CI", () => {
    const workflow = read(".github/workflows/factory.yml");
    for (const step of ["node scripts/check-personal.mjs", "devcontainer build", "installer-twice.sh", "macos-latest", "ubuntu:24.04"]) expect(workflow).toContain(step);
    expect(existsSync(join(REPOSITORY, "test/ci/installer-twice.sh"))).toBe(true);
  });
});
