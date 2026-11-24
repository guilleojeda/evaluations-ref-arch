import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { basename } from "node:path";
import test from "node:test";
import ts from "typescript";
import { uiText } from "../controller/src/ui-text.ts";

const disallowed = /(?!-)[\u00b7\p{Dash}]/u;

for (const component of ["app", "controller"]) {
  test(`${component} interface copy uses plain hyphens`, () => {
    const root = new URL(`../${component}/`, import.meta.url);
    assert.doesNotMatch(readFileSync(new URL("index.html", root), "utf8"), disallowed);
    const src = new URL("src/", root);
    const files = readdirSync(src, { recursive: true }).filter(name => name.endsWith(".tsx") || basename(name) === "inventory-display.mjs");
    for (const name of files) {
      const code = readFileSync(new URL(name, src), "utf8");
      const tree = ts.createSourceFile(name, code, ts.ScriptTarget.Latest, true);
      function check(node) {
        if (ts.isJsxText(node) || ts.isStringLiteralLike(node) || ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node)) {
          const line = tree.getLineAndCharacterOfPosition(node.getStart(tree)).line + 1;
          assert.doesNotMatch(node.text, disallowed, `${component}/src/${name}:${line}`);
        }
        ts.forEachChild(node, check);
      }
      check(tree);
    }
  });
}

test("presentation formatting also covers saved report prose", () => {
  assert.equal(uiText("Read\u00b7role\u2014version 31\u201332"), "Read - role-version 31-32");
  assert.equal(uiText("request-id-123"), "request-id-123");
});
