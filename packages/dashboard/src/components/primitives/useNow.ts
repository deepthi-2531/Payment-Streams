/**
 * `useNow` — re-renders every `interval` ms so callers can drive live counters.
 *
 * Ported from the mock at `Canton Streams/src/primitives.jsx`. Returns the
 * current wall-clock `Date.now()` and refreshes on a fixed interval. Callers
 * that only need a low-frequency tick (~1Hz) should pass `1000`; live
 * accrual displays can pass smaller values like 80–100ms.
 *
 * Shared clock hook for live dashboard values.
 */
import { useEffect, useState } from 'react';

export function useNow(interval = 80): number {
  const [t, setT] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setT(Date.now()), interval);
    return () => clearInterval(id);
  }, [interval]);
  return t;
}
