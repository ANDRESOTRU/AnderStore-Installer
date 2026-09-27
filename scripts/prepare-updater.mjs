import { readFileSync, writeFileSync } from "node:fs";
import { resolve, join, basename } from "node:path";
import { pathToFileURL } from "node:url";
import { validateManifest } from "./validate-updater.mjs";

// Draft releases expose API asset URLs. Replace only URLs tied to this draft's asset inventory.
export function prepareManifest(manifest, assets, version, repository) {
  const result = structuredClone(manifest);
  for (const platform of Object.values(result.platforms ?? {})) {
    const matches = assets.filter((asset) => asset.apiUrl === platform.url);
    if (matches.length) {
      const asset = matches[0];
      if (matches.length !== 1 || !/^https:\/\/api\.github\.com\/repos\/[\w.-]+\/[\w.-]+\/releases\/assets\/\d+$/.test(asset.apiUrl) ||
          !asset.apiUrl.startsWith(`https://api.github.com/repos/${repository}/releases/assets/`) ||
          asset.name !== basename(asset.name) || asset.name.includes("\\") || !asset.name.endsWith(".exe") || asset.state !== "uploaded") {
        throw new Error("Updater must reference an uploaded installer in this draft");
      }
      platform.url = `https://github.com/${repository}/releases/download/v${version}/${encodeURIComponent(asset.name)}`;
    }
  }
  validateManifest(result, version, repository);
  return result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [, , directory, version, repository] = process.argv;
  const path = join(directory, "latest.json");
  const manifest = JSON.parse(readFileSync(path, "utf8"));
  const { assets } = JSON.parse(readFileSync(join(directory, "release-assets.json"), "utf8"));
  writeFileSync(path, JSON.stringify(prepareManifest(manifest, assets, version, repository), null, 2));
}
