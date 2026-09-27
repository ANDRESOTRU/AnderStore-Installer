import { readFileSync } from "node:fs";
import { resolve, join, basename } from "node:path";
import { pathToFileURL } from "node:url";
import { createHash, createPublicKey, verify } from "node:crypto";

const decodeMinisign = (text) => text.trim().startsWith("untrusted comment:")
  ? text.trim() : Buffer.from(text.trim(), "base64").toString("utf8").trim();

// Verify the same prehashed Minisign format used by Tauri, including the trusted comment.
export function verifySignature(bytes, encodedSignature, encodedPublicKey) {
  const publicLines = decodeMinisign(encodedPublicKey).split(/\r?\n/);
  const lines = decodeMinisign(encodedSignature).split(/\r?\n/);
  const publicPacket = Buffer.from(publicLines[1] ?? "", "base64");
  const packet = Buffer.from(lines[1] ?? "", "base64");
  const global = Buffer.from(lines[3] ?? "", "base64");
  const algorithm = packet.subarray(0, 2).toString();
  if (publicPacket.length !== 42 || packet.length !== 74 || global.length !== 64 ||
      !["ED", "Ed"].includes(algorithm) || !lines[2]?.startsWith("trusted comment: ") ||
      !publicPacket.subarray(2, 10).equals(packet.subarray(2, 10))) {
    throw new Error("Invalid updater signature or signing key does not match installed clients");
  }
  const key = createPublicKey({ key: Buffer.concat([
    Buffer.from("302a300506032b6570032100", "hex"), publicPacket.subarray(10),
  ]), format: "der", type: "spki" });
  const signature = packet.subarray(10);
  const message = algorithm === "ED" ? createHash("blake2b512").update(bytes).digest() : bytes;
  if (!verify(null, message, key, signature) ||
      !verify(null, Buffer.concat([signature, Buffer.from(lines[2].slice(17))]), key, global)) {
    throw new Error("Updater cryptographic signature verification failed");
  }
}

export function validateManifest(manifest, version, repository) {
  if (manifest.version !== version) throw new Error("Updater version does not match release");
  const platform = manifest.platforms?.["windows-x86_64"];
  if (!platform?.signature || !platform?.url) throw new Error("Missing Windows x64 updater");
  const nsis = manifest.platforms["windows-x86_64-nsis"];
  if (nsis && (nsis.url !== platform.url || nsis.signature !== platform.signature)) {
    throw new Error("Windows NSIS updater must match the verified Windows installer");
  }
  const url = new URL(platform.url);
  const prefix = `/${repository}/releases/download/v${version}/`;
  const name = decodeURIComponent(url.pathname.slice(prefix.length));
  if (url.protocol !== "https:" || url.hostname !== "github.com" || url.username || url.password ||
      !url.pathname.startsWith(prefix) || url.search || url.hash ||
      name !== basename(name) || name.includes("\\") || !name.endsWith(".exe")) {
    throw new Error("Updater URL must reference the Windows installer in this release");
  }
  return { ...platform, name };
}

export function validateRelease(directory, version, repository, publicKey) {
  const manifest = JSON.parse(readFileSync(join(directory, "latest.json"), "utf8"));
  const platform = validateManifest(manifest, version, repository);
  const signature = readFileSync(join(directory, `${platform.name}.sig`), "utf8").trim();
  if (signature !== platform.signature.trim()) throw new Error("Manifest and uploaded signature differ");
  verifySignature(readFileSync(join(directory, platform.name)), signature, publicKey);
  return platform.name;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [, , directory, version, repository] = process.argv;
  const config = JSON.parse(readFileSync("src-tauri/tauri.conf.json", "utf8"));
  const name = validateRelease(directory, version, repository, config.plugins.updater.pubkey);
  console.log(`Verified signed Windows updater: ${name} (${version})`);
}
