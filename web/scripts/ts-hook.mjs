/**
 * Lets a plain `node` script import the app's own TypeScript modules.
 *
 * Node 23 strips types by itself, but it will not guess extensions, and the app's source uses the
 * extensionless specifiers TypeScript expects. This hook supplies only that missing step, so the
 * verification scripts exercise the real `lib/` code rather than a reimplementation of it — the
 * whole point being to catch a mismatch between what the tests assume and what ships.
 */
import { register } from "node:module";
import { pathToFileURL } from "node:url";

register(
  new URL(
    `data:text/javascript,
    import { existsSync } from "node:fs";
    import { fileURLToPath, pathToFileURL } from "node:url";
    export async function resolve(specifier, context, next) {
      if (specifier.startsWith(".") && !/\\.(ts|tsx|js|mjs|json)$/.test(specifier)) {
        const base = new URL(specifier, context.parentURL);
        for (const candidate of [base.href + ".ts", base.href + "/index.ts"]) {
          if (existsSync(fileURLToPath(candidate))) {
            return next(candidate, context);
          }
        }
      }
      return next(specifier, context);
    }`.replace(/\s+/g, " "),
  ),
  pathToFileURL("./"),
);
