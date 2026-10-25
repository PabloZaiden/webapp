import { useEffect, useState, type ImgHTMLAttributes } from "react";
import { appPath, appRequest, appResourceUrl, getWebAppClientMode } from "./api-client";
import { getClientSession } from "./client-session";

/** Loads private API images without exposing bearer credentials in image URLs. */
export function ResourceImage({ src, ...props }: Omit<ImgHTMLAttributes<HTMLImageElement>, "src"> & { src: string }) {
  const external = getWebAppClientMode() === "external";
  const remote = (getClientSession().enabled || external) && !/^(blob:|data:)/i.test(src);
  const [resource, setResource] = useState<{ src: string; url?: string; error?: Error }>();
  useEffect(() => {
    if (!remote) return;
    const controller = new AbortController();
    let dispose: (() => void) | undefined;
    async function load() {
      try {
        if (external) {
          const resource = await appResourceUrl(src, "resource", { signal: controller.signal });
          if (controller.signal.aborted) {
            resource.dispose?.();
            return;
          }
          dispose = resource.dispose;
          setResource({ src, url: resource.url });
          return;
        }
        const response = await appRequest(src, { signal: controller.signal });
        if (!response.ok) throw new Error(`Unable to load image (${response.status}).`);
        const blob = await response.blob();
        if (controller.signal.aborted) return;
        const objectUrl = URL.createObjectURL(blob);
        dispose = () => URL.revokeObjectURL(objectUrl);
        setResource({ src, url: objectUrl });
      } catch (error) {
        if (!controller.signal.aborted) setResource({
          src, error: error instanceof Error ? error : new Error(String(error)),
        });
      }
    }
    void load();
    return () => {
      controller.abort();
      dispose?.();
    };
  }, [src, remote, external]);
  if (!remote) return <img src={appPath(src)} {...props} />;
  const current = resource?.src === src ? resource : undefined;
  if (current?.error) return <span className={props.className} role="img"
    title={current.error.message} aria-label={current.error.message}>!</span>;
  if (!current?.url) return <span className={props.className} aria-hidden="true" />;
  return <img src={current.url} {...props} />;
}
