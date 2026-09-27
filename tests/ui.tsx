// Local UI fixture. It never talks to Apple, a real iPhone, or the release server.
import { mockIPC } from "@tauri-apps/api/mocks";
import { emit } from "@tauri-apps/api/event";

const language = new URLSearchParams(location.search).get("lang") ?? "ru";
localStorage.setItem("i18nextLng", language);
const phone = { name: "Тестовый iPhone", udid: "fixture-phone", id: 1, connectionType: "USB", version: "18.0" };
const data: Record<string, unknown> = {
  lang: language,
  installationReceipts: { "fixture-phone": {
    deviceId: phone.udid, deviceName: phone.name, iosVersion: phone.version,
    appleId: "installation-account@example.com", installedAt: "2026-09-27T10:00:00Z",
  } },
};
mockIPC(async (command, payload) => {
  switch (command) {
    case "plugin:store|load": return 1;
    case "plugin:store|keys": return Object.keys(data);
    case "plugin:store|get": return [data[String(payload?.key)], String(payload?.key) in data];
    case "plugin:store|set": data[String(payload?.key)] = payload?.value; return;
    case "plugin:store|save": return;
    case "plugin:app|version": return "2.3.7";
    case "keyring_available": return true;
    case "list_devices": return [{ Ok: phone }];
    case "has_stored_rppairing": return true;
    case "set_selected_device": return;
    case "logged_in_as": return "installation-account@example.com";
    case "installed_pairing_apps": return [{ name: "AnderStore", bundleId: "test.anderstore", path: "test" }];
    case "plugin:updater|check": return {
      rid: 2, currentVersion: "2.3.7", version: "2.3.8", rawJson: {},
    };
    case "plugin:updater|download": throw new Error("Simulated offline download — UI fixture");
    case "install_sidestore_operation":
      for (const stepId of ["download", "install", "pairing"]) {
        await emit("operation_install_sidestore", { updateType: "started", stepId });
        await emit("operation_install_sidestore", { updateType: "finished", stepId });
      }
      return;
    default: return;
  }
}, { shouldMockEvents: true });
await import("../src/main");
