export class ActivityGate {
  private current: string | null = null;
  private listeners = new Set<() => void>();
  getSnapshot = () => this.current;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };
  async run<T>(name: string, work: () => Promise<T>): Promise<T> {
    if (this.current) throw new Error("Another operation is still running");
    this.current = name;
    this.listeners.forEach((listener) => listener());
    try { return await work(); }
    finally {
      this.current = null;
      this.listeners.forEach((listener) => listener());
    }
  }
}

