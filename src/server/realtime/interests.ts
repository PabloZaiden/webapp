import type { RealtimeInterest } from "../../contracts/realtime";
import { createLogger } from "../logger";

export type RealtimeInterestListener = (interests: readonly RealtimeInterest[]) => void;

export interface RealtimeInterestObserverOptions {
  /** Close or suspend the upstream source when forwarding current interests fails. */
  onError?: (error: unknown) => void;
}

interface Snapshot {
  key: string;
  interests: readonly RealtimeInterest[];
}

interface Observer {
  userId: string;
  listener: RealtimeInterestListener;
  options: RealtimeInterestObserverOptions;
  key?: string;
  active: boolean;
}

const log = createLogger("webapp:realtime");

function canonicalInterest(interest: RealtimeInterest): RealtimeInterest {
  const copy: RealtimeInterest = {
    kinds: [...new Set(interest.kinds)].sort(),
    resources: interest.resources ? [...new Set(interest.resources)].sort() : undefined,
    actions: interest.actions ? [...new Set(interest.actions)].sort() : undefined,
    ids: interest.ids ? [...new Set(interest.ids)].sort() : undefined,
    scopes: interest.scopes ? [...new Set(interest.scopes)].sort() : undefined,
    types: interest.types ? [...new Set(interest.types)].sort() : undefined,
    targets: interest.targets ? Object.fromEntries(Object.keys(interest.targets).sort().map(key => {
      const value = interest.targets![key]!;
      const values = Array.isArray(value) ? [...new Set(value)].sort() : value;
      if (Array.isArray(values)) Object.freeze(values);
      return [key, values];
    })) : undefined,
  };
  for (const value of Object.values(copy)) {
    if (value && typeof value === "object") Object.freeze(value);
  }
  return Object.freeze(copy);
}

/** Current snapshots only; pending work is bounded to one entry per observed user. */
export class RealtimeInterestObservers {
  private readonly observers = new Map<string, Set<Observer>>();
  private readonly pending = new Set<string>();
  private count = 0;
  private scheduled = false;
  private disposing = false;

  constructor(
    private readonly read: (userId: string) => Iterable<RealtimeInterest>,
    private readonly limit: number,
  ) {}

  observe(userId: string, listener: RealtimeInterestListener, options: RealtimeInterestObserverOptions = {}): () => void {
    if (!userId) throw new TypeError("A realtime interest observer requires a userId");
    if (this.disposing) throw new Error("Realtime interest observers are being disposed");
    if (this.count >= this.limit) throw new RangeError("Realtime interest observer limit reached");
    const observer: Observer = { userId, listener, options, active: true };
    const listeners = this.observers.get(userId) ?? new Set<Observer>();
    listeners.add(observer);
    this.observers.set(userId, listeners);
    this.count++;
    this.emit(observer, this.snapshot(userId), true);
    return () => this.remove(observer);
  }

  changed(userId: string | undefined): void {
    if (!userId || !this.observers.has(userId) || this.disposing) return;
    this.pending.add(userId);
    if (this.scheduled) return;
    this.scheduled = true;
    queueMicrotask(() => {
      this.scheduled = false;
      const users = [...this.pending];
      this.pending.clear();
      for (const id of users) {
        const listeners = this.observers.get(id);
        if (!listeners) continue;
        const snapshot = this.snapshot(id);
        for (const observer of [...listeners]) this.emit(observer, snapshot);
      }
    });
  }

  dispose(): void {
    if (this.disposing) return;
    this.disposing = true;
    this.pending.clear();
    try {
      const empty: Snapshot = { key: "[]", interests: Object.freeze([]) };
      for (const listeners of this.observers.values()) {
        for (const observer of [...listeners]) {
          this.emit(observer, empty);
          this.remove(observer);
        }
      }
    } finally {
      this.disposing = false;
    }
  }

  private snapshot(userId: string): Snapshot {
    const interests = new Map<string, RealtimeInterest>();
    for (const interest of this.read(userId)) {
      const copy = canonicalInterest(interest);
      interests.set(JSON.stringify(copy), copy);
    }
    const values = Object.freeze([...interests.keys()].sort().map(key => interests.get(key)!));
    return { key: JSON.stringify(values), interests: values };
  }

  private remove(observer: Observer): void {
    if (!observer.active) return;
    observer.active = false;
    const listeners = this.observers.get(observer.userId);
    listeners?.delete(observer);
    this.count--;
    if (listeners?.size === 0) {
      this.observers.delete(observer.userId);
      this.pending.delete(observer.userId);
    }
  }

  private emit(observer: Observer, snapshot: Snapshot, initial = false): void {
    if (!observer.active || observer.key === snapshot.key) return;
    observer.key = snapshot.key;
    try {
      const result: unknown = observer.listener(snapshot.interests);
      // Callbacks are synchronous; still surface an accidentally returned rejection.
      if (result && typeof result === "object" && "then" in result) {
        void Promise.resolve(result).catch(error => this.failed(observer, error));
      }
    } catch (error) {
      this.failed(observer, error);
      if (initial) throw error;
    }
  }

  private failed(observer: Observer, error: unknown): void {
    if (!observer.active) return;
    this.remove(observer);
    log.error("Realtime interest observer failed", { error: String(error) });
    try {
      observer.options.onError?.(error);
    } catch (failure) {
      log.error("Realtime interest observer failure handler failed", { error: String(failure) });
    }
  }
}
