import type { RealtimeInterest } from "../../contracts/realtime";

export type RealtimeStatus = "connecting" | "open" | "closed";
export interface RealtimeActivation { generation: number }
export interface RealtimeSubscriber<TEvent = unknown> {
  interest: RealtimeInterest;
  onEvent: (event: TEvent) => void;
  onSubscribed?: (activation: RealtimeActivation) => void | Promise<void>;
  onStatus?: (status: RealtimeStatus) => void;
  onError?: (error: Error) => void;
}

export interface RealtimeSource {
  subscribe<TEvent>(subscriber: RealtimeSubscriber<TEvent>): () => void;
  recoverFromNetworkFailure?(error: Error): void;
  dispose(): void;
}
