import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Source-level guards that the prototype portal experience cannot quietly come
// back: the development launcher stays removed, catch-all routes stay deleted,
// navigation only points at pages that exist, the shared shell carries no
// fabricated identities or badges, and no route imports the eval-based mock
// renderers.

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (relative) => readFileSync(path.join(root, relative), "utf8");
const exists = (relative) => existsSync(path.join(root, relative));

function walk(relativeDir) {
  const full = path.join(root, relativeDir);
  const entries = readdirSync(full, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const child = path.join(relativeDir, entry.name);
    if (entry.isDirectory()) files.push(...walk(child));
    else files.push(child);
  }
  return files;
}

test("the development screen launcher is gone from the application", () => {
  assert.equal(exists("src/components/AppLauncher.tsx"), false);
  assert.ok(!/AppLauncher/.test(read("src/app/layout.tsx")));
});

test("catch-all prototype routes are deleted so arbitrary paths 404", () => {
  assert.equal(exists("src/app/student/[[...path]]"), false);
  assert.equal(exists("src/app/instructor/[[...path]]"), false);
  assert.equal(exists("src/app/student/page.tsx"), true);
  assert.equal(exists("src/app/instructor/page.tsx"), true);
});

test("portal navigation only lists real, existing pages", () => {
  const nav = read("src/lib/nav.ts");
  const routes = [...nav.matchAll(/route:\s*"([^"]+)"/g)].map((match) => match[1]);

  assert.ok(routes.length > 0, "navigation must not be empty");
  for (const route of routes) {
    assert.ok(!/messages|notifications|settings|earnings|availability|revisions|submissions|deliverables|help/.test(route), `mock destination ${route} is still linked`);
    assert.ok(exists(`src/app${route}/page.tsx`), `navigation route ${route} has no real page`);
  }

  assert.ok(!/badge\s*:/.test(nav), "navigation must not carry hardcoded badges");
});

test("the shared shell contains no fabricated identities or badges", () => {
  const shell = read("src/components/Shell.tsx");
  const forbidden = [
    "Elena Vance",
    "Dr. Ananya",
    "Stanford",
    "Oxford",
    "Fall 2025",
    "INSTRUCTOR NODE WITNESS",
    "Synced #",
    "unread",
  ];
  for (const value of forbidden) {
    assert.ok(!shell.includes(value), `Shell still contains fabricated content: ${value}`);
  }

  // The shell must accept real identity from server pages and fall back
  // neutrally when none is supplied.
  assert.ok(shell.includes("ShellUser"));
  assert.ok(shell.includes("Your account"));
});

test("no application route imports the eval-based mock renderers", () => {
  const appFiles = walk("src/app").filter((file) => file.endsWith(".tsx") || file.endsWith(".ts"));
  assert.ok(appFiles.length > 0);
  for (const file of appFiles) {
    const source = read(file);
    assert.ok(!/ScriptRunner/.test(source), `${file} must not import ScriptRunner`);
    assert.ok(!/ScreenRenderer/.test(source), `${file} must not import ScreenRenderer`);
    assert.ok(
      !/DocumentUploadEnhancer/.test(source),
      `${file} must not import DocumentUploadEnhancer`,
    );
  }
});

test("the obsolete prototype tree and executors stay deleted", () => {
  const removed = [
    "src/screens",
    "src/components/ScreenRenderer.tsx",
    "src/components/ScriptRunner.tsx",
    "src/components/Placeholder.tsx",
    "src/components/DocumentUploadEnhancer.tsx",
    "scripts/extract.mjs",
    "screens-src",
  ];
  for (const relative of removed) {
    assert.equal(exists(relative), false, `${relative} must not come back`);
  }
});

test("nothing in src references the deleted prototype components", () => {
  const files = walk("src").filter((file) => file.endsWith(".ts") || file.endsWith(".tsx"));
  assert.ok(files.length > 0);
  for (const file of files) {
    const source = read(file);
    for (const name of ["ScriptRunner", "ScreenRenderer", "Placeholder", "DocumentUploadEnhancer"]) {
      assert.ok(!source.includes(name), `${file} still references ${name}`);
    }
  }
});

test("no source file executes dynamic code or injects raw HTML", () => {
  const files = walk("src").filter((file) => file.endsWith(".ts") || file.endsWith(".tsx"));
  assert.ok(files.length > 0);
  for (const file of files) {
    const source = read(file);
    // `eval(...)` / `(0, eval)(...)` — CSP literal 'unsafe-eval' is allowed.
    assert.ok(!/(?<!unsafe-)\beval\b\s*[({)]/.test(source), `${file} must not use eval`);
    assert.ok(!/new\s+Function\b/.test(source), `${file} must not build functions from strings`);
    assert.ok(!/dangerouslySetInnerHTML/.test(source), `${file} must not inject raw HTML`);
  }
});
