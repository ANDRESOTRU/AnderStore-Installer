import test from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, sign, createHash } from "node:crypto";
import { readFileSync, writeFileSync, mkdtempSync, rmSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { validateManifest, verifySignature, validateRelease } from "../scripts/validate-updater.mjs";
import { prepareManifest } from "../scripts/prepare-updater.mjs";

test("draft API URLs become public versioned URLs only for this release's uploaded installer", () => {
  const apiUrl = "https://api.github.com/repos/ANDRESOTRU/AnderStore-Installer/releases/assets/123";
  const manifest = { version: "2.3.8", platforms: { "windows-x86_64": { url: apiUrl, signature: "sig" }, "windows-x86_64-nsis": { url: apiUrl, signature: "sig" } } };
  const assets = [{ apiUrl, name: "AnderStore.Installer_2.3.8_x64-setup.exe", state: "uploaded" }];
  const prepared = prepareManifest(manifest, assets, "2.3.8", "ANDRESOTRU/AnderStore-Installer");
  assert.equal(prepared.platforms["windows-x86_64"].url, "https://github.com/ANDRESOTRU/AnderStore-Installer/releases/download/v2.3.8/AnderStore.Installer_2.3.8_x64-setup.exe");
  assert.equal(manifest.platforms["windows-x86_64"].url, apiUrl);
  assert.throws(() => prepareManifest(manifest, [], "2.3.8", "ANDRESOTRU/AnderStore-Installer"));
  assert.throws(() => prepareManifest(manifest, [{ ...assets[0], name: "../bad.exe" }], "2.3.8", "ANDRESOTRU/AnderStore-Installer"));
  assert.throws(() => prepareManifest(manifest, [{ ...assets[0], state: "new" }], "2.3.8", "ANDRESOTRU/AnderStore-Installer"));
  prepared.platforms["windows-x86_64-nsis"].signature = "different";
  assert.throws(() => validateManifest(prepared, "2.3.8", "ANDRESOTRU/AnderStore-Installer"));
});

const fixture = (algorithm = "ED") => {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const id = Buffer.from("0102030405060708", "hex");
  const key = Buffer.concat([Buffer.from("Ed"), id, publicKey.export({ format: "der", type: "spki" }).subarray(-32)]);
  const bytes = Buffer.from("installer test data");
  const message = algorithm === "ED" ? createHash("blake2b512").update(bytes).digest() : bytes;
  const signature = sign(null, message, privateKey);
  const comment = "timestamp:123 file:installer.exe";
  const global = sign(null, Buffer.concat([signature, Buffer.from(comment)]), privateKey);
  return { bytes,
    publicKey: Buffer.from(`untrusted comment: test key\n${key.toString("base64")}\n`).toString("base64"),
    signature: Buffer.from(`untrusted comment: test\n${Buffer.concat([Buffer.from(algorithm), id, signature]).toString("base64")}\ntrusted comment: ${comment}\n${global.toString("base64")}\n`).toString("base64"),
  };
};
test("release manifest requires matching version, platform and asset URL", () => {
  const manifest = { version: "2.3.7", platforms: { "windows-x86_64": {
    signature: "test", url: "https://github.com/ANDRESOTRU/AnderStore-Installer/releases/download/v2.3.7/Installer.exe",
  } } };
  assert.equal(validateManifest(manifest, "2.3.7", "ANDRESOTRU/AnderStore-Installer").name, "Installer.exe");
  assert.throws(() => validateManifest(manifest, "2.3.8", "ANDRESOTRU/AnderStore-Installer"));
  assert.throws(() => validateManifest({ ...manifest, platforms: {} }, "2.3.7", "ANDRESOTRU/AnderStore-Installer"));
  for (const url of ["https://example.com/Installer.exe", "https://github.com/other/repo/releases/download/v2.3.7/Installer.exe", "https://github.com/ANDRESOTRU/AnderStore-Installer/releases/download/v2.3.7/%2e%2e%5cInstaller.exe"]) {
    assert.throws(() => validateManifest({ ...manifest, platforms: { "windows-x86_64": { signature: "test", url } } }, "2.3.7", "ANDRESOTRU/AnderStore-Installer"));
  }
});
test("verify both Minisign algorithms and reject tampering or different key", () => {
  for (const algorithm of ["ED", "Ed"]) {
    const signed = fixture(algorithm);
    verifySignature(signed.bytes, signed.signature, signed.publicKey);
    assert.throws(() => verifySignature(Buffer.from("modified installer"), signed.signature, signed.publicKey));
    assert.throws(() => verifySignature(signed.bytes, signed.signature, fixture().publicKey));
    const changedComment = Buffer.from(Buffer.from(signed.signature, "base64").toString().replace("timestamp:123", "timestamp:999")).toString("base64");
    assert.throws(() => verifySignature(signed.bytes, changedComment, signed.publicKey));
  }
});
test("Russian and English guide/update strings contain matching keys and interpolation", () => {
  const ru = JSON.parse(readFileSync("src/locales/ru.json", "utf8"));
  const en = JSON.parse(readFileSync("src/locales/en.json", "utf8"));
  for (const section of ["guide", "update", "apple_id"]) {
    assert.deepEqual(Object.keys(ru[section]).sort(), Object.keys(en[section]).sort());
    for (const key of Object.keys(ru[section])) {
      assert.deepEqual(ru[section][key].match(/\{\{\w+\}\}/g), en[section][key].match(/\{\{\w+\}\}/g));
    }
  }
});

test("release validator accepts actual Tauri CLI output and blocks incomplete or modified releases", () => {
  const prefix = join(tmpdir(), "anderstore-signing-test-");
  const directory = mkdtempSync(prefix);
  try {
    const keyPath = join(directory, "test.key");
    const installer = join(directory, "Installer.exe");
    const cli = resolve("node_modules/@tauri-apps/cli/tauri.js");
    const generate = spawnSync(process.execPath, [cli, "signer", "generate", "--ci", "-p", "test-only", "-w", keyPath], { encoding: "utf8" });
    assert.equal(generate.status, 0, "Tauri test key generation must succeed");
    writeFileSync(installer, "test installer bytes");
    const signing = spawnSync(process.execPath, [cli, "signer", "sign", "-f", keyPath, "-p", "test-only", installer], { encoding: "utf8" });
    assert.equal(signing.status, 0, "Tauri test signing must succeed");
    const signature = readFileSync(`${installer}.sig`, "utf8").trim();
    const publicKey = readFileSync(`${keyPath}.pub`, "utf8").trim();
    writeFileSync(join(directory, "latest.json"), JSON.stringify({ version: "2.3.7", platforms: {
      "windows-x86_64": { url: "https://github.com/ANDRESOTRU/AnderStore-Installer/releases/download/v2.3.7/Installer.exe", signature },
    } }));
    assert.equal(validateRelease(directory, "2.3.7", "ANDRESOTRU/AnderStore-Installer", publicKey), "Installer.exe");
    writeFileSync(installer, "modified installer bytes");
    assert.throws(() => validateRelease(directory, "2.3.7", "ANDRESOTRU/AnderStore-Installer", publicKey));
    unlinkSync(`${installer}.sig`);
    assert.throws(() => validateRelease(directory, "2.3.7", "ANDRESOTRU/AnderStore-Installer", publicKey));
  } finally {
    if (!resolve(directory).startsWith(resolve(prefix))) throw new Error("Unexpected signing test directory");
    rmSync(directory, { recursive: true, force: true });
  }
});
