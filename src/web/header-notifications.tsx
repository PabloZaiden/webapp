import { useId, useState, type RefObject } from "react";
import { Button, Modal } from "./components";
import { TOAST_VARIANT_LABELS, useToast, type Toast, type ToastVariant } from "./toast";

function NotificationIcon({ variant }: { variant: ToastVariant }) {
  return (
    <svg className="wapp-notification-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {variant === "warning" ? <path d="m12 3 10 18H2Z" /> : <circle cx="12" cy="12" r="9" />}
      {variant === "success" ? <path d="m8 12 2.5 2.5L16 9" /> : variant === "info" ? <path d="M12 11v6M12 7h.01" /> : <path d="M12 8v5M12 17h.01" />}
    </svg>
  );
}

export function HeaderNotifications({ focusFallbackRef }: { focusFallbackRef: RefObject<HTMLElement | null> }) {
  const { toasts, dismiss } = useToast();
  const messageId = useId();
  const [details, setDetails] = useState<readonly Toast[]>([]);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const current = toasts.findLast((toast) => toast.variant === "error") ?? toasts.at(-1);

  const openDetails = (notification: Toast) => {
    setDetails([notification, ...toasts.filter((toast) => toast !== notification).reverse()]);
    setDetailsOpen(true);
  };
  const closeDetails = () => setDetailsOpen(false);
  const dismissDetails = () => {
    for (const toast of details) {
      if (toasts.includes(toast)) {
        dismiss(toast.id);
      }
    }
    closeDetails();
  };

  return (
    <>
      {current ? (
        <button
          type="button"
          className={`wapp-header-notification wapp-notification-${current.variant}`}
          aria-label={toasts.length > 1 ? `View notifications (${toasts.length} active)` : "View notifications"}
          aria-describedby={messageId}
          aria-haspopup="dialog"
          onClick={() => openDetails(current)}
        >
          <NotificationIcon variant={current.variant} />
          <span id={messageId} className="wapp-header-notification-message">{current.message}</span>
          {toasts.length > 1 ? <span className="wapp-header-notification-count" aria-hidden="true">+{toasts.length - 1}</span> : null}
          <svg className="wapp-header-notification-chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m9 5 7 7-7 7" /></svg>
        </button>
      ) : null}
      <Modal
        isOpen={detailsOpen}
        onClose={closeDetails}
        title={details.length === 1 ? "Notification" : "Notifications"}
        restoreFocusFallbackRef={focusFallbackRef}
        size="sm"
        footer={<Button type="button" onClick={dismissDetails}>{details.length === 1 ? "Dismiss" : "Dismiss all"}</Button>}
      >
        <div className="wapp-notification-details">
          {details.map((toast) => (
            <section key={toast.id}>
              <h3 className={`wapp-notification-${toast.variant}`}><NotificationIcon variant={toast.variant} />{TOAST_VARIANT_LABELS[toast.variant]}</h3>
              <p>{toast.message}</p>
            </section>
          ))}
        </div>
      </Modal>
    </>
  );
}
