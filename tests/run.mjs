import ts from "typescript";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { registerBehaviorTests } from "./behavior.mjs";
import "./release.test.mjs";

// Compile the production controller with the project's existing TypeScript dependency.
const prefix = join(tmpdir(), "anderstore-tests-");
const directory = mkdtempSync(prefix);
process.on("exit", () => {
  if (!resolve(directory).startsWith(resolve(prefix))) throw new Error("Unexpected test directory");
  rmSync(directory, { recursive: true, force: true });
});
const modules = {};
for (const name of ["activityGate", "updateController", "installationReceipt"]) {
  const source = readFileSync(`src/${name}.ts`, "utf8");
  const { outputText } = ts.transpileModule(source, { compilerOptions: {
    module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022,
  } });
  const path = join(directory, `${name}.mjs`);
  writeFileSync(path, outputText.replace(/from "(\.\/[^".]+)"/g, 'from "$1.mjs"'));
  Object.assign(modules, await import(pathToFileURL(path).href));
}
registerBehaviorTests(modules);
