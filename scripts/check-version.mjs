import { readFileSync } from "node:fs";
const pkg = JSON.parse(readFileSync("package.json", "utf8"));
const config = JSON.parse(readFileSync("src-tauri/tauri.conf.json", "utf8"));
const rust = readFileSync("src-tauri/Cargo.toml", "utf8").match(/^version = "([^"]+)"/m)?.[1];
const lock = readFileSync("src-tauri/Cargo.lock", "utf8").match(/name = "anderstore-installer"\r?\nversion = "([^"]+)"/)?.[1];
if (!/^\d+\.\d+\.\d+$/.test(pkg.version) || [config.version, rust, lock].some((version) => version !== pkg.version)) {
  throw new Error("package.json, tauri.conf.json, Cargo.toml and Cargo.lock versions must match");
}
console.log(`Project version: ${pkg.version}`);
