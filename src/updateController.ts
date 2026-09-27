import { ActivityGate } from "./activityGate";
export type DownloadEvent =
  | { event: "Started"; data: { contentLength?: number } }
  | { event: "Progress"; data: { chunkLength: number } }
  | { event: "Finished" };
export interface UpdateHandle {
  currentVersion: string;
  version: string;
  download: (onEvent: (event: DownloadEvent) => void) => Promise<void>;
  install: () => Promise<void>;
  close: () => Promise<void>;
}
export type UpdateState = {
  phase: "idle" | "checking" | "current" | "available" | "downloading" | "installing" | "error";
  visible: boolean;
  currentVersion?: string;
  version?: string;
  downloaded: number;
  total?: number;
  error?: string;
};
export class UpdateController {
  private state: UpdateState = { phase: "idle", visible: false, downloaded: 0 };
  private listeners = new Set<() => void>();
  private update: UpdateHandle | null = null;
  private checking = false;
  private updating = false;
  constructor(private api: {
    check: () => Promise<UpdateHandle | null>;
    relaunch: () => Promise<void>;
  }, private gate: ActivityGate) {}
  getSnapshot = () => this.state;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };
  private set(patch: Partial<UpdateState>) {
    this.state = { ...this.state, ...patch };
    this.listeners.forEach((listener) => listener());
  }
  dismiss = () => {
    if (!this.updating) this.set({ visible: false });
  };
  check = async (manual = false) => {
    if (this.updating) return;
    if (this.checking) {
      if (manual) this.set({ visible: true });
      return;
    }
    this.checking = true;
    this.set({ phase: "checking", visible: manual, error: undefined, downloaded: 0, total: undefined });
    try {
      if (this.update) await this.update.close();
      this.update = null;
      const update = await this.api.check();
      this.update = update;
      this.set({ phase: update ? "available" : "current", visible: update ? true : this.state.visible,
        currentVersion: update?.currentVersion, version: update?.version });
    } catch (error) {
      this.set({ phase: "error", error: String(error) });
    } finally { this.checking = false; }
  };
  install = async () => {
    if (this.updating || this.checking || !this.update || this.gate.getSnapshot()) return;
    this.updating = true;
    const update = this.update;
    try {
      await this.gate.run("update", async () => {
        this.set({ phase: "downloading", visible: true, downloaded: 0, total: undefined, error: undefined });
        await update.download((event) => {
          if (event.event === "Started") {
            this.set({ total: event.data.contentLength && event.data.contentLength > 0 ? event.data.contentLength : undefined });
          } else if (event.event === "Progress") {
            this.set({ downloaded: this.state.downloaded + event.data.chunkLength });
          }
        });
        this.set({ phase: "installing" });
        // Windows exits after launching NSIS, which restarts the app. Other platforms resolve.
        await update.install();
        await this.api.relaunch();
      });
    } catch (error) {
      this.set({ phase: "error", visible: true, error: String(error) });
    } finally { this.updating = false; }
  };
}
