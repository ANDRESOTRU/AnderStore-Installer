import { check } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import { activity } from "./activity";
import { UpdateController } from "./updateController";

export const updates = new UpdateController({ check: () => check({ timeout: 15000 }), relaunch }, activity);
