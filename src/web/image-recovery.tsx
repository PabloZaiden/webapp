import { useCallback, useEffect, useState, type ImgHTMLAttributes } from "react";
import { createLogger } from "./logger";

interface ImageRecoveryState {
  identity: unknown;
  attempt: number;
  retried: boolean;
  error?: Error;
}

export function useImageRecovery(identity: unknown) {
  const [state, setState] = useState<ImageRecoveryState>({ identity, attempt: 0, retried: false });
  const current: ImageRecoveryState = state.identity === identity ? state : { identity, attempt: 0, retried: false };
  // Retire old event handlers before committing the replacement image.
  if (state.identity !== identity) setState(current);
  const { attempt, error } = current;
  const onError = useCallback((error: Error) => {
    setState(previous => {
      if (previous.identity !== identity || previous.attempt !== attempt) return previous;
      return previous.retried || document.hidden || !navigator.onLine
        ? { ...previous, error }
        : { identity, attempt: attempt + 1, retried: true };
    });
  }, [identity, attempt]);
  const onLoad = useCallback(() => {
    setState(previous => {
      if (previous.identity !== identity || previous.attempt !== attempt) return previous;
      return { identity, attempt, retried: false };
    });
  }, [identity, attempt]);

  useEffect(() => {
    const retry = () => {
      if (document.hidden || !navigator.onLine) return;
      setState(previous => previous.identity === identity && previous.error
        ? { identity, attempt: previous.attempt + 1, retried: true }
        : previous);
    };
    window.addEventListener("online", retry);
    window.addEventListener("focus", retry);
    document.addEventListener("visibilitychange", retry);
    return () => {
      window.removeEventListener("online", retry);
      window.removeEventListener("focus", retry);
      document.removeEventListener("visibilitychange", retry);
    };
  }, [identity]);
  useEffect(() => {
    if (error) createLogger("webapp:image").warn("Image could not be loaded.", { name: error.name });
  }, [error]);

  return { attempt, error, onError, onLoad };
}

export function RecoverableImage({ src, onError, onLoad, ...props }:
  Omit<ImgHTMLAttributes<HTMLImageElement>, "src"> & { src: string }) {
  const recovery = useImageRecovery(src);
  return <img {...props} key={`${src}\0${recovery.attempt}`} src={src}
    title={recovery.error?.message ?? props.title}
    onError={event => {
      recovery.onError(new Error("Unable to load image."));
      onError?.(event);
    }}
    onLoad={event => {
      recovery.onLoad();
      onLoad?.(event);
    }} />;
}
