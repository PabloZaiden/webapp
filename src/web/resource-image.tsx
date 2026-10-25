import { useEffect, useMemo, useState, type ImgHTMLAttributes } from "react";
import { appPath, appRequest, appResourceUrl, getWebAppClientMode } from "./api-client";
import { getClientSession } from "./client-session";
import { useExternalClientSession } from "./webapp-config";

/** Loads private API images without exposing bearer credentials in image URLs. */
export function ResourceImage({ src, ...props }: Omit<ImgHTMLAttributes<HTMLImageElement>, "src"> & { src: string }) {
  const external = getWebAppClientMode() === "external";
  const remote = (getClientSession().enabled || external) && !/^(blob:|data:)/i.test(src);
  const session = useExternalClientSession();
  const identity = useMemo(() => ({
    src, scope: session?.scope, generation: session?.generation,
    ready: session?.ready ?? true, error: session?.error,
  }), [src, session?.scope, session?.generation, session?.ready, session?.error]);
  const [resource, setResource] = useState<{ identity: typeof identity; url?: string; error?: Error }>();
  useEffect(() => {
    if (!remote || !identity.ready || identity.error) return;
    const controller = new AbortController();
    let dispose: (() => void) | undefined;
    async function load() {
      try {
        if (external) {
          const resource = await appResourceUrl(identity.src, "resource", { signal: controller.signal });
          if (controller.signal.aborted) {
            resource.dispose?.();
            return;
          }
          dispose = () => resource.dispose?.();
          setResource({ identity, url: resource.url });
          return;
        }
        const response = await appRequest(identity.src, { signal: controller.signal });
        if (!response.ok) throw new Error(`Unable to load image (${response.status}).`);
        const blob = await response.blob();
        if (controller.signal.aborted) return;
        const objectUrl = URL.createObjectURL(blob);
        dispose = () => URL.revokeObjectURL(objectUrl);
        setResource({ identity, url: objectUrl });
      } catch (error) {
        if (!controller.signal.aborted) setResource({
          identity, error: error instanceof Error ? error : new Error(String(error)),
        });
      }
    }
    void load();
    return () => {
      controller.abort();
      dispose?.();
    };
  }, [identity, remote, external]);
  if (!remote) return <img src={appPath(src)} {...props} />;
  const current = resource?.identity === identity ? resource : undefined;
  const error = identity.error ?? current?.error;
  if (error) return <span className={props.className} role="img"
    title={error.message} aria-label={error.message}>!</span>;
  if (!current?.url) return <span className={props.className} aria-hidden="true" />;
  return <img src={current.url} {...props} />;
}
