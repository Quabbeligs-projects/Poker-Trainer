/**
 * Per-hand countdown for the time trial.
 *
 * Returns the seconds left and fires `onExpire` once when they run out. The
 * timer is keyed on the hand so it restarts cleanly, and it never fires twice
 * for the same hand — a double submit would grade an already-finished hand.
 */
import { useEffect, useRef, useState } from 'react';

export function useHandTimer(
  seconds: number | null,
  key: string,
  onExpire: () => void,
): number | null {
  const [remaining, setRemaining] = useState<number | null>(seconds);
  const fired = useRef(false);
  const expire = useRef(onExpire);
  expire.current = onExpire;

  useEffect(() => {
    fired.current = false;
    setRemaining(seconds);
    if (seconds === null) return undefined;
    const deadline = Date.now() + seconds * 1000;
    const tick = window.setInterval(() => {
      const left = Math.max(0, Math.ceil((deadline - Date.now()) / 1000));
      setRemaining(left);
      if (left <= 0 && !fired.current) {
        fired.current = true;
        window.clearInterval(tick);
        expire.current();
      }
    }, 250);
    return () => window.clearInterval(tick);
  }, [seconds, key]);

  return remaining;
}
