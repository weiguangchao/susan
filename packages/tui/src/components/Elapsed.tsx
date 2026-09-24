import { useEffect, useState } from "react";
import { Text } from "ink";
import { formatDuration } from "../duration.js";

/**
 * Time since `since`, ticking while mounted. The interval lives only as long
 * as the component, so an idle screen never re-renders.
 */
export function Elapsed({ since }: { since: number }) {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 150);
    return () => clearInterval(timer);
  }, []);

  return <Text>{formatDuration(now - since)}</Text>;
}
