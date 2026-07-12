export const MOBILE_BREAKPOINT_PX = 900;
export const MOBILE_MEDIA_QUERY = `(max-width: ${MOBILE_BREAKPOINT_PX}px)`;
export const MOBILE_STATE_ATTRIBUTE = "data-wapp-mobile";

/*
 * Mobile Safari/WebKit and Chromium can report focus or orientation changes
 * before visualViewport reaches its final geometry. The first retry catches
 * the post-event layout pass; the final retry catches the end of the keyboard,
 * browser-chrome, or rotation transition when no further event is emitted.
 */
export const MOBILE_VIEWPORT_FIRST_SETTLE_DELAY_MS = 120;
export const MOBILE_VIEWPORT_FINAL_SETTLE_DELAY_MS = 320;
