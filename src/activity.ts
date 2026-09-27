import { useSyncExternalStore } from "react";
import { invoke as tauriInvoke, type InvokeArgs, type InvokeOptions } from "@tauri-apps/api/core";

import { ActivityGate } from "./activityGate";

export const activity = new ActivityGate();
export const useActivity = () => useSyncExternalStore(activity.subscribe, activity.getSnapshot);
const exclusiveCommands = new Set([
  "login_new", "login_stored", "invalidate_account", "delete_account",
  "set_selected_device", "cancel_pairing", "place_pairing_cmd", "delete_stored_rppairing",
  "revoke_certificate", "delete_app_id", "reset_anisette_state", "force_disable_keyring",
  "sideload_operation", "install_sidestore_operation",
]);
export function invoke<T>(command: string, args?: InvokeArgs, options?: InvokeOptions): Promise<T> {
  // Cancellation continues the existing pairing operation, like submitting a 2FA code.
  if (command === "cancel_pairing" && activity.getSnapshot() === "set_selected_device") {
    return tauriInvoke<T>(command, args, options);
  }
  return exclusiveCommands.has(command)
    ? activity.run(command, () => tauriInvoke<T>(command, args, options))
    : tauriInvoke<T>(command, args, options);
}
