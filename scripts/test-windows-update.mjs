import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync, existsSync, cpSync } from "node:fs";
import { join } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
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
async function until(task, label, timeout = 120000, interval = 500) {
  const deadline = Date.now() + timeout;
  let last;
  while (Date.now() < deadline) {
    try { const result = await task(); if (result) return result; } catch (error) { if (error?.fatal) throw error; last = error; }
    await pause(interval);
  }
  throw new Error(`Timed out: ${label}. ${last ?? ""}`);
}
async function get(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(60000) });
  if (!response.ok) throw new Error(`Download failed: HTTP ${response.status}`);
  return response;
}
const latest = await until(async () => {
  const manifest = await (await get(`${base}/latest/download/latest.json`)).json();
  return manifest.version === expected ? manifest : undefined;
}, "published signed release", 600000, 10000);
assert.equal(latest.version, expected, "Test must exercise the expected published release");
const oldManifest = await (await get(`${base}/download/v${baseline}/latest.json`)).json();
const oldPlatform = oldManifest.platforms["windows-x86_64"];
const installer = Buffer.from(await (await get(oldPlatform.url)).arrayBuffer());
verifySignature(installer, oldPlatform.signature, config.plugins.updater.pubkey);
const setupPath = join(output, "baseline-setup.exe");
writeFileSync(setupPath, installer);
const testUsername = "AnderStoreTest";
const testProfile = join(process.env.SYSTEMDRIVE + "\\Users", testUsername);
const testEnvironment = { ...process.env,
  ANDERSTORE_SMOKE_USERNAME: testUsername,
  ANDERSTORE_SMOKE_PASSWORD: "A!1" + randomBytes(32).toString("hex"),
  ANDERSTORE_SMOKE_PROFILE: testProfile,
  WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: "--remote-debugging-port=19227",
};
const account = spawnSync("pwsh.exe", ["-NoProfile", "-Command", "$secret = ConvertTo-SecureString $env:ANDERSTORE_SMOKE_PASSWORD -AsPlainText -Force; New-LocalUser -Name $env:ANDERSTORE_SMOKE_USERNAME -Password $secret -PasswordNeverExpires -ErrorAction Stop | Out-Null; Add-LocalGroupMember -SID 'S-1-5-32-545' -Member $env:ANDERSTORE_SMOKE_USERNAME -ErrorAction Stop"], { encoding: "utf8", windowsHide: true, env: testEnvironment });
assert.equal(account.status, 0, `Create isolated ordinary test user: ${account.stderr}`);
const launcher = "scripts/launch-standard-user-smoke.ps1";
const profileSetup = spawnSync("pwsh.exe", ["-NoProfile", "-File", launcher, "-Executable", join(process.env.WINDIR, "System32", "cmd.exe"), "-Arguments", "/d /c exit 0", "-Wait"], { encoding: "utf8", windowsHide: true, env: testEnvironment });
assert.equal(profileSetup.status, 0, `Initialize test profile: ${profileSetup.stderr}`);
const installationDirectory = join(testProfile, "AppData", "Local", "anderstore-updater-smoke");
assert.ok(!/\s/.test(installationDirectory), "CI installation directory must be unambiguous for runas");
const install = spawnSync("pwsh.exe", ["-NoProfile", "-File", launcher, "-Executable", join(process.cwd(), setupPath), "-Arguments", `/S /D=${installationDirectory}`, "-Wait"], { timeout: 180000, windowsHide: true, encoding: "utf8", env: testEnvironment });
assert.equal(install.status, 0, "Baseline NSIS installation must succeed");
const executable = join(installationDirectory, "anderstore-installer.exe");
assert.ok(existsSync(executable), "Test must run the installed app");
console.log(`Installed baseline executable: ${executable}`);
const appData = join(testProfile, "AppData", "Roaming", "uk.andresot.anderstore.installer");
const preferencesPath = join(appData, "preferences.json");
mkdirSync(appData, { recursive: true });
const receipts = Object.fromEntries([1, 2].map((n) => [`ci-test-${n}`, {
  deviceId: `ci-test-${n}`, deviceName: `CI Test iPhone ${n}`, iosVersion: "18.0",
  appleId: `ci-account-${n}@example.com`, installedAt: "2026-09-27T00:00:00.000Z",
}]));
writeFileSync(preferencesPath, JSON.stringify({ installationReceipts: receipts }));
const port = 19227;
// Use an actual standard account: hosted runners disable UAC and synthetic
// restricted administrator tokens do not behave like a normal installer user.
const app = spawn("pwsh.exe", ["-NoProfile", "-File", launcher, "-Executable", executable], { stdio: "inherit", env: testEnvironment });
app.on("error", (error) => console.log(`Baseline launch failed: ${error}`));
let launchFailure;
app.on("exit", (code, signal) => {
  console.log(`Baseline launcher exited: code=${code}, signal=${signal}`);
  if (code !== 0) { launchFailure = new Error(`Baseline launcher failed: ${code}`); launchFailure.fatal = true; }
});
app.unref();
let client;
async function connect() {
  if (launchFailure) throw launchFailure;
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
    const version = spawnSync("pwsh.exe", ["-NoProfile", "-Command", "(Get-Item -LiteralPath $env:ANDERSTORE_SMOKE_EXE).VersionInfo.ProductVersion"], {
      encoding: "utf8", windowsHide: true, env: { ...process.env, ANDERSTORE_SMOKE_EXE: executable },
    });
    return version.status === 0 && version.stdout.trim() === expected;
  }, "native updater installation", 180000);
  client.close();
  client = await until(async () => {
    const candidate = await connect();
    if (!candidate) return;
    client = candidate;
    let accepted = false;
    try {
      accepted = await evaluate(`document.querySelector('header')?.innerText.includes(${JSON.stringify(expected)})`);
      if (accepted) return candidate;
    } finally {
      if (!accepted) candidate.close();
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
} finally {
  client?.close();
  const diagnostic = spawnSync("pwsh.exe", ["-NoProfile", "-Command", "Get-Process | Where-Object { $_.ProcessName -match 'anderstore|msedgewebview' } | Select-Object ProcessName,Id,Path,SessionId | ConvertTo-Json"], { encoding: "utf8", windowsHide: true });
  writeFileSync(join(output, "processes.json"), diagnostic.stdout);
  const logs = join(appData, "logs");
  if (existsSync(logs)) cpSync(logs, join(output, "app-logs"), { recursive: true });
}
