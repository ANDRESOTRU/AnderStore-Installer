export type InstallationReceipt = {
  deviceId: string;
  deviceName: string;
  iosVersion: string;
  appleId: string;
  installedAt: string;
};
export type ReceiptMap = Record<string, InstallationReceipt>;
export function readReceipts(value: unknown): ReceiptMap {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value).flatMap(([key, entry]) => {
    if (!entry || typeof entry !== "object") return [];
    const receipt = entry as Record<string, unknown>;
    const fields = ["deviceId", "deviceName", "iosVersion", "appleId", "installedAt"] as const;
    if (!fields.every((field) => typeof receipt[field] === "string" && receipt[field]) ||
        receipt.deviceId !== key || !Number.isFinite(Date.parse(receipt.installedAt as string))) return [];
    return [[key, Object.fromEntries(fields.map((field) => [field, receipt[field]])) as InstallationReceipt]];
  }));
}
export function createReceipt(device: { udid: string; name: string; version: string }, appleId: string): InstallationReceipt {
  if (!device.udid || !appleId) throw new Error("Device and signing account are required");
  return { deviceId: device.udid, deviceName: device.name, iosVersion: device.version, appleId, installedAt: new Date().toISOString() };
}
export function withReceipt(receipts: ReceiptMap, receipt: InstallationReceipt): ReceiptMap {
  return { ...receipts, [receipt.deviceId]: { ...receipt } };
}

export async function completeInstallation(snapshot: InstallationReceipt, install: () => Promise<void>): Promise<InstallationReceipt> {
  const receipt = { ...snapshot };
  await install();
  return { ...receipt, installedAt: new Date().toISOString() };
}
