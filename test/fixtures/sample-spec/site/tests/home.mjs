import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

const home = await readFile(new URL("../index.html", import.meta.url), "utf8");

test("the home page names the bakery", () => {
  assert.match(home, /<h1>The Corner Bakery<\/h1>/);
});
