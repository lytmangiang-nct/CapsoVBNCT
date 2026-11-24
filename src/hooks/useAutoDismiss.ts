import { useEffect, useRef } from 'react';

export const NOTIFICATION_AUTO_DISMISS_MS = 30_000;

/**
 * Automatically invokes `onDismiss` after `durationMs` (default 30s) whenever `value` is truthy.
 * Resets the countdown whenever `value` changes and cleans up on unmount.
 */
export function useAutoDismiss<T>(
  value: T,
  onDismiss: () => void,
  durationMs: number = NOTIFICATION_AUTO_DISMISS_MS
): void {
  const onDismissRef = useRef(onDismiss);
  onDismissRef.current = onDismiss;

  useEffect(() => {
    if (!value) return;
    const timer = window.setTimeout(() => {
      onDismissRef.current();
    }, durationMs);
    return () => {
      window.clearTimeout(timer);
    };
  }, [value, durationMs]);
}
