import { registerHooks } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// Test-only module resolver (loaded via `node --import ./scripts/ts-resolve-hook.mjs`).
//
// Node's native TypeScript support requires explicit file extensions in import
// specifiers, but the application source uses TypeScript's conventional
// extensionless imports and the "@/" path alias. This hook adds only that
// resolution behavior so tests exercise the real, unmodified application code.

const here = path.dirname(fileURLToPath(import.meta.url));
const srcIndexUrl = pathToFileURL(path.resolve(here, "..", "src", "index.ts")).href;

const EXTENSIONS = [".ts", ".tsx", ".mts", ".js", ".mjs", "/index.ts", "/index.tsx"];

function resolveWithExtensions(specifier, context, nextResolve) {
  try {
    return nextResolve(specifier, context);
  } catch (error) {
    if (error?.code !== "ERR_MODULE_NOT_FOUND") throw error;
    for (const ext of EXTENSIONS) {
      try {
        return nextResolve(specifier + ext, context);
      } catch (inner) {
        if (inner?.code !== "ERR_MODULE_NOT_FOUND") throw inner;
      }
    }
    throw error;
  }
}

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith("@/")) {
      return resolveWithExtensions("./" + specifier.slice(2), { ...context, parentURL: srcIndexUrl }, nextResolve);
    }
    if (specifier.startsWith(".") || specifier.startsWith("/")) {
      return resolveWithExtensions(specifier, context, nextResolve);
    }
    return nextResolve(specifier, context);
  },
});
