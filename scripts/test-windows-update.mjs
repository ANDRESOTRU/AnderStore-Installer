import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { verifySignature } from "./validate-updater.mjs";

// Runs on an isolated Windows CI runner. CDP observes the real installed WebView;
// updater IPC, signature verification, NSIS installation and restart are not mocked.
assert.equal(process.platform, "win32");
const expected = process.argv[2] ?? "2.3.8";
const baseline = "2.3.7";
const output = "out/windows-update-smoke";
mkdirSync(output, { recursive: true });
const config = JSON.parse(readFileSync("src-tauri/tauri.conf.json", "utf8"));
const base = "https://github.com/ANDRESOTRU/AnderStore-Installer/releases";
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(task, label, timeout = 120000) {
  const deadline = Date.now() + timeout;
  let last;
  while (Date.now() < deadline) {
    try { const result = await task(); if (result) return result; } catch (error) { last = error; }
    await pause(500);
  }
  throw new Error(`Timed out: ${label}. ${last ?? ""}`);
}
async function get(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(60000) });
  if (!response.ok) throw new Error(`Download failed: HTTP ${response.status}`);
  return response;
}
const latest = await (await get(`${base}/latest/download/latest.json`)).json();
assert.equal(latest.version, expected, "Test must exercise the expected published release");
const oldManifest = await (await get(`${base}/download/v${baseline}/latest.json`)).json();
const oldPlatform = oldManifest.platforms["windows-x86_64"];
const installer = Buffer.from(await (await get(oldPlatform.url)).arrayBuffer());
verifySignature(installer, oldPlatform.signature, config.plugins.updater.pubkey);
const setupPath = join(output, "baseline-setup.exe");
writeFileSync(setupPath, installer);
const install = spawnSync(setupPath, ["/S"], { timeout: 180000, windowsHide: true });
assert.equal(install.status, 0, "Baseline NSIS installation must succeed");
const executable = join(process.env.LOCALAPPDATA, "AnderStore Installer", "anderstore-installer.exe");
assert.ok(existsSync(executable), "Test must run the installed app");
const preferencesPath = join(process.env.APPDATA, "uk.andresot.anderstore.installer", "preferences.json");
mkdirSync(join(process.env.APPDATA, "uk.andresot.anderstore.installer"), { recursive: true });
const receipts = Object.fromEntries([1, 2].map((n) => [`ci-test-${n}`, {
  deviceId: `ci-test-${n}`, deviceName: `CI Test iPhone ${n}`, iosVersion: "18.0",
  appleId: `ci-account-${n}@example.com`, installedAt: "2026-09-27T00:00:00.000Z",
}]));
writeFileSync(preferencesPath, JSON.stringify({ installationReceipts: receipts }));
const port = 19227;
const app = spawn(executable, [], { detached: true, stdio: "ignore", env: {
  ...process.env, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port}`,
} });
app.unref();
let client;
async function connect() {
  const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(2000) })).json();
  const target = targets.find((target) => target.type === "page" && /tauri\.localhost/.test(target.url));
  if (!target) return;
  const socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { socket.addEventListener("open", resolve, { once: true }); socket.addEventListener("error", reject, { once: true }); });
  let nextId = 0;
  const pending = new Map();
  socket.addEventListener("message", ({ data }) => {
    const response = JSON.parse(data);
    const waiter = pending.get(response.id);
    if (waiter) {
      clearTimeout(waiter.timer); pending.delete(response.id);
      response.error ? waiter.reject(new Error(response.error.message)) : waiter.resolve(response.result);
    }
  });
  socket.addEventListener("close", () => {
    for (const waiter of pending.values()) { clearTimeout(waiter.timer); waiter.reject(new Error("WebView closed")); }
    pending.clear();
  });
  return {
    close: () => socket.close(),
    call: (method, params = {}) => new Promise((resolve, reject) => {
      const id = ++nextId;
      const timer = setTimeout(() => { pending.delete(id); reject(new Error(`CDP timeout: ${method}`)); }, 5000);
      pending.set(id, { resolve, reject, timer });
      socket.send(JSON.stringify({ id, method, params }));
    }),
  };
}
async function evaluate(expression) {
  const value = await client.call("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
  if (value.exceptionDetails) throw new Error(JSON.stringify(value.exceptionDetails));
  return value.result.value;
}
async function snapshot(name) {
  const text = await evaluate("document.body.innerText");
  writeFileSync(join(output, `${name}.txt`), text);
  try {
    const screenshot = await client.call("Page.captureScreenshot");
    writeFileSync(join(output, `${name}.png`), Buffer.from(screenshot.data, "base64"));
  } catch { /* Text and binary version remain the required evidence. */ }
  return text;
}
try {
  client = await until(connect, "installed baseline WebView");
  await until(() => evaluate("document.querySelector('.update-card .primary-install')?.disabled === false"), "enabled update button");
  const before = await snapshot("before-update");
  assert.ok(before.includes(baseline) && before.includes(expected), "Card must show installed and new versions");
  console.log(`Installed ${baseline}; real updater offers ${expected}.`);
  await evaluate("document.querySelector('.update-card .primary-install').click()");
  let observedProgress = false;
  await until(async () => {
    try {
      const text = await evaluate("document.querySelector('.update-card')?.innerText ?? ''");
      if (/Downloading|Скачивание|Installing|Установка|Загрузка/.test(text)) {
        observedProgress = true;
        writeFileSync(join(output, "progress.txt"), text);
      }
      if (await evaluate("!!document.querySelector('.update-card details pre')")) {
        throw new Error(await evaluate("document.querySelector('.update-card details pre').innerText"));
      }
    } catch (error) {
      if (!/WebView closed|CDP timeout|WebSocket/.test(String(error))) {
        writeFileSync(join(output, "update-error.txt"), String(error));
      }
    }
    const version = spawnSync("powershell.exe", ["-NoProfile", "-Command", "(Get-Item -LiteralPath $env:ANDERSTORE_SMOKE_EXE).VersionInfo.ProductVersion"], {
      encoding: "utf8", windowsHide: true, env: { ...process.env, ANDERSTORE_SMOKE_EXE: executable },
    });
    return version.status === 0 && version.stdout.trim() === expected;
  }, "native updater installation", 180000);
  client.close();
  client = await until(async () => {
    const candidate = await connect();
    if (!candidate) return;
    client = candidate;
    try {
      if (await evaluate(`document.querySelector('header')?.innerText.includes(${JSON.stringify(expected)})`)) return candidate;
    } finally {
      if (!(await evaluate(`document.querySelector('header')?.innerText.includes(${JSON.stringify(expected)})`).catch(() => false))) candidate.close();
    }
  }, "new version in restarted WebView");
  await until(() => evaluate("!!document.querySelector('details.saved-guides')"), "saved guides after restart");
  await evaluate("document.querySelectorAll('details.saved-guides, details.saved-guides > details').forEach(details => details.open = true)");
  const after = await snapshot("after-update");
  for (const receipt of Object.values(receipts)) assert.ok(after.includes(receipt.appleId), "Saved guide must remain accessible");
  const saved = JSON.parse(readFileSync(preferencesPath, "utf8"));
  assert.deepEqual(saved.installationReceipts, receipts, "Both accounts and dates must survive the actual update");
  writeFileSync(join(output, "result.json"), JSON.stringify({ baseline, updated: expected, restarted: true, receiptsPreserved: 2, observedProgress }, null, 2));
  console.log(`PASS: ${baseline} → ${expected}; native signed update, automatic restart, and both saved guides verified.`);
} finally { client?.close(); }
