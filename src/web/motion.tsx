import { Children, cloneElement, Fragment, isValidElement, useCallback, useEffect, useRef, useState, type ReactNode } from "react";

export const MOTION_FAST_MS = 350;
export const MOTION_NORMAL_MS = 350;

export type MotionPresenceState = "enter" | "idle" | "exit";

function prefersReducedMotion(): boolean {
  return typeof window !== "undefined"
    && typeof window.matchMedia === "function"
    && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

export function useReducedMotion(): boolean {
  const [reducedMotion, setReducedMotion] = useState(prefersReducedMotion);

  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
      return;
    }

    const mediaQuery = window.matchMedia("(prefers-reduced-motion: reduce)");
    const update = () => setReducedMotion(mediaQuery.matches);
    update();
    if (mediaQuery.addEventListener) {
      mediaQuery.addEventListener("change", update);
    } else {
      mediaQuery.addListener?.(update);
    }

    return () => {
      if (mediaQuery.removeEventListener) {
        mediaQuery.removeEventListener("change", update);
      } else {
        mediaQuery.removeListener?.(update);
      }
    };
  }, []);

  return reducedMotion;
}

export function usePresence(
  present: boolean,
  { duration = MOTION_FAST_MS }: { duration?: number } = {},
): {
  mounted: boolean;
  state: MotionPresenceState;
  reducedMotion: boolean;
} {
  const reducedMotion = useReducedMotion();
  const [mounted, setMounted] = useState(present);
  const [state, setState] = useState<MotionPresenceState>(present ? "enter" : "idle");

  useEffect(() => {
    if (present) {
      setMounted(true);
      setState(reducedMotion ? "idle" : "enter");

      if (reducedMotion) {
        return;
      }

      const frameId = window.requestAnimationFrame(() => setState("idle"));
      return () => window.cancelAnimationFrame(frameId);
    }

    if (!mounted) {
      return;
    }

    if (reducedMotion || duration <= 0) {
      setState("idle");
      setMounted(false);
      return;
    }

    setState("exit");
    const timer = setTimeout(() => {
      setState("idle");
      setMounted(false);
    }, duration);

    return () => clearTimeout(timer);
  }, [duration, mounted, present, reducedMotion]);

  return { mounted, state, reducedMotion };
}

export function Presence({
  present,
  duration = MOTION_FAST_MS,
  children,
}: {
  present: boolean;
  duration?: number;
  children: (state: MotionPresenceState) => ReactNode;
}) {
  const presence = usePresence(present, { duration });
  if (!presence.mounted) {
    return null;
  }
  return children(presence.state);
}

export function Collapsible({
  open,
  id,
  className = "",
  duration = MOTION_NORMAL_MS,
  children,
}: {
  open: boolean;
  id?: string;
  className?: string;
  duration?: number;
  children: ReactNode;
}) {
  const collapsibleRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (open) {
      return;
    }
    const activeElement = document.activeElement;
    if (activeElement instanceof HTMLElement && collapsibleRef.current?.contains(activeElement)) {
      activeElement.blur();
    }
  }, [open]);

  return (
    <Presence present={open} duration={duration}>
      {(state) => (
        <div
          ref={collapsibleRef}
          id={id}
          className={`wapp-collapsible wapp-collapsible-${state} ${className}`.trim()}
          data-open={open ? "true" : "false"}
          aria-hidden={open ? undefined : true}
        >
          <div className="wapp-collapsible-inner">{children}</div>
        </div>
      )}
    </Presence>
  );
}

export type AsyncStateStatus = "loading" | "refreshing" | "empty" | "error" | "ready";

export function AsyncState({
  status,
  loading,
  empty,
  error,
  refreshing,
  children,
  className = "",
}: {
  status: AsyncStateStatus;
  loading?: ReactNode;
  empty?: ReactNode;
  error?: ReactNode;
  refreshing?: ReactNode;
  children?: ReactNode;
  className?: string;
}) {
  const content = status === "loading"
    ? loading
    : status === "empty"
      ? empty
      : status === "error"
        ? error
        : children;

  return (
    <div
      key={status === "refreshing" ? "ready" : status}
      className={`wapp-async-state wapp-async-state-${status} ${className}`.trim()}
      aria-busy={status === "loading" || status === "refreshing" ? true : undefined}
    >
      {content}
      {status === "refreshing" && refreshing ? (
        <div className="wapp-async-state-refreshing" role="status">
          {refreshing}
        </div>
      ) : null}
    </div>
  );
}

export interface StreamingTextProps {
  content: string;
  active?: boolean;
  as?: "div" | "span";
  className?: string;
  chunkClassName?: string;
  duration?: number;
  maxPendingChars?: number;
}

/**
 * Displays append-only text with one sequentially fading chunk at a time.
 * Initial content is rendered immediately; only post-mount appends are queued.
 */
export function StreamingText({
  content,
  active = true,
  as = "span",
  className = "",
  chunkClassName = "",
  duration = MOTION_FAST_MS,
  maxPendingChars = 16_384,
}: StreamingTextProps) {
  const reducedMotion = useReducedMotion();
  const previousContentRef = useRef<string | null>(null);
  const activeChunkRef = useRef<string | null>(null);
  const pendingContentRef = useRef("");
  const [committedContent, setCommittedContent] = useState(content);
  const [activeChunk, setActiveChunk] = useState<string | null>(null);
  const [pendingContent, setPendingContent] = useState("");

  const resetToContent = useCallback((nextContent: string) => {
    previousContentRef.current = nextContent;
    activeChunkRef.current = null;
    pendingContentRef.current = "";
    setCommittedContent(nextContent);
    setActiveChunk(null);
    setPendingContent("");
  }, []);

  useEffect(() => {
    if (!active || reducedMotion) {
      resetToContent(content);
      return;
    }

    const previousContent = previousContentRef.current;
    previousContentRef.current = content;
    if (previousContent === null) {
      resetToContent(content);
      return;
    }
    if (content === previousContent || !content.startsWith(previousContent)) {
      if (content !== previousContent) {
        resetToContent(content);
      }
      return;
    }

    const delta = content.slice(previousContent.length);
    if (!delta) {
      return;
    }

    const nextPendingLength = pendingContentRef.current.length + delta.length;
    if (nextPendingLength > Math.max(1, maxPendingChars)) {
      resetToContent(content);
      return;
    }

    if (activeChunkRef.current !== null || pendingContentRef.current.length > 0) {
      pendingContentRef.current += delta;
      setPendingContent(pendingContentRef.current);
      return;
    }

    activeChunkRef.current = delta;
    setActiveChunk(delta);
  }, [active, content, maxPendingChars, reducedMotion, resetToContent]);

  useEffect(() => {
    if (activeChunk === null) {
      return;
    }

    if (duration <= 0 || reducedMotion) {
      const completedChunk = activeChunkRef.current;
      if (completedChunk !== null) {
        activeChunkRef.current = null;
        setCommittedContent((current) => current + completedChunk);
        setActiveChunk(null);
      }
      return;
    }

    const timer = setTimeout(() => {
      const completedChunk = activeChunkRef.current;
      if (completedChunk === null) {
        return;
      }
      activeChunkRef.current = null;
      setCommittedContent((current) => current + completedChunk);
      setActiveChunk(null);
    }, duration);

    return () => clearTimeout(timer);
  }, [activeChunk, duration, reducedMotion]);

  useEffect(() => {
    if (activeChunk !== null || !pendingContent) {
      return;
    }

    const nextChunk = pendingContentRef.current;
    if (!nextChunk) {
      return;
    }
    pendingContentRef.current = "";
    setPendingContent("");
    activeChunkRef.current = nextChunk;
    setActiveChunk(nextChunk);
  }, [activeChunk, pendingContent]);

  const Element = as;
  if (!active || reducedMotion) {
    return <Element className={className}>{content}</Element>;
  }

  return (
    <Element className={className} data-wapp-streaming-text="active">
      {committedContent}
      {activeChunk ? (
        <span className={`wapp-streaming-text-chunk wapp-motion-enter ${chunkClassName}`.trim()}>
          {activeChunk}
        </span>
      ) : null}
    </Element>
  );
}

/**
 * Animates keyed children entering and leaving a collection. Callers should
 * provide stable keys so a refresh does not turn an existing item into a new
 * animation entry.
 */
export function AnimatedList({
  children,
  className = "",
  duration = MOTION_FAST_MS,
}: {
  children: ReactNode;
  className?: string;
  duration?: number;
}) {
  const childMap = new Map<string, ReactNode>();
  Children.toArray(children).forEach((child, index) => {
    const key = isValidElement(child) && child.key !== null ? String(child.key) : `index-${index}`;
    childMap.set(key, child);
  });

  const childrenRef = useRef<Map<string, ReactNode> | null>(null);
  const exitingChildrenRef = useRef(new Map<string, ReactNode>());
  if (childrenRef.current === null) {
    childrenRef.current = childMap;
  } else {
    for (const [key, child] of childrenRef.current) {
      if (!childMap.has(key)) {
        exitingChildrenRef.current.set(key, child);
      }
    }
    childrenRef.current = childMap;
  }

  const [entries, setEntries] = useState<AnimatedListEntryState[]>(() => (
    Array.from(childMap.keys(), (key) => ({ key, present: true, animate: false }))
  ));

  useEffect(() => {
    setEntries((current) => {
      const currentByKey = new Map(current.map((entry) => [entry.key, entry]));
      const next: AnimatedListEntryState[] = [];

      for (const key of childMap.keys()) {
        const existing = currentByKey.get(key);
        next.push(existing?.present
          ? existing
          : existing
            ? { ...existing, present: true, animate: true }
            : { key, present: true, animate: true });
      }

      for (const entry of current) {
        if (!childMap.has(entry.key)) {
          next.push(entry.present ? { ...entry, present: false, animate: true } : entry);
        }
      }

      if (
        next.length === current.length
        && next.every((entry, index) => {
          const previous = current[index];
          return previous?.key === entry.key
            && previous.present === entry.present
            && previous.animate === entry.animate;
        })
      ) {
        return current;
      }
      return next;
    });
  }, [childMap]);

  const removeExited = useCallback((key: string) => {
    exitingChildrenRef.current.delete(key);
    setEntries((current) => current.filter((entry) => entry.key !== key || entry.present));
  }, []);

  return (
    <div className={`wapp-animated-list ${className}`.trim()}>
      {entries.map((entry) => {
        const child = childMap.get(entry.key) ?? exitingChildrenRef.current.get(entry.key);
        if (child === undefined) {
          return null;
        }
        return (
          <AnimatedListEntry
            key={entry.key}
            entryKey={entry.key}
            child={child}
            present={entry.present}
            animate={entry.animate}
            duration={duration}
            onExitComplete={removeExited}
          />
        );
      })}
    </div>
  );
}

interface AnimatedListEntryState {
  key: string;
  present: boolean;
  animate: boolean;
}

type MotionChildProps = {
  className?: string;
  ["data-wapp-motion"]?: string;
  ["aria-hidden"]?: boolean;
};

function AnimatedListEntry({
  entryKey,
  child,
  present,
  animate,
  duration,
  onExitComplete,
}: {
  entryKey: string;
  child: ReactNode;
  present: boolean;
  animate: boolean;
  duration: number;
  onExitComplete: (key: string) => void;
}) {
  const presence = usePresence(present, { duration });

  useEffect(() => {
    if (animate && !present && !presence.mounted) {
      onExitComplete(entryKey);
    }
  }, [animate, entryKey, onExitComplete, presence.mounted, present]);

  if (!presence.mounted) {
    return null;
  }

  const state = animate ? presence.state : "idle";
  if (isValidElement<MotionChildProps>(child) && child.type !== Fragment) {
    const className = [child.props.className, `wapp-motion-${state}`].filter(Boolean).join(" ");
    return cloneElement(child, {
      className,
      "data-wapp-motion": state,
      "aria-hidden": state === "exit" ? true : child.props["aria-hidden"],
    });
  }

  return (
    <span className={`wapp-animated-list-item wapp-motion-${state}`} data-wapp-motion={state} aria-hidden={state === "exit" ? true : undefined}>
      {child}
    </span>
  );
}
