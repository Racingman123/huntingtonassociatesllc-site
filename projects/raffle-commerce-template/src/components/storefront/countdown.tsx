"use client";

import { useEffect, useState } from "react";

function getRemaining(target: string) {
  const difference = Math.max(0, new Date(target).getTime() - Date.now());
  return {
    total: difference,
    days: Math.floor(difference / 86_400_000),
    hours: Math.floor((difference / 3_600_000) % 24),
    minutes: Math.floor((difference / 60_000) % 60),
    seconds: Math.floor((difference / 1_000) % 60),
  };
}

export function Countdown({ target, label = "Entries close in" }: { target: string; label?: string }) {
  // Date.now() during SSR and hydration can land on different seconds. Start
  // from a deterministic shell, then activate the clock in the browser.
  const [remaining, setRemaining] = useState<ReturnType<typeof getRemaining> | null>(null);

  useEffect(() => {
    const initial = window.setTimeout(() => setRemaining(getRemaining(target)), 0);
    const interval = window.setInterval(() => setRemaining(getRemaining(target)), 1000);
    return () => {
      window.clearTimeout(initial);
      window.clearInterval(interval);
    };
  }, [target]);

  if (!remaining) {
    return <div className="countdown countdown-loading" aria-label={`${label}; timer loading`}><p>{label}</p></div>;
  }
  if (remaining.total === 0) return <p className="countdown-ended">This entry period has closed.</p>;

  return (
    <div className="countdown" aria-label={`${label}: ${remaining.days} days, ${remaining.hours} hours, ${remaining.minutes} minutes`}>
      <p>{label}</p>
      <div aria-hidden="true">
        {[
          [remaining.days, "Days"],
          [remaining.hours, "Hours"],
          [remaining.minutes, "Minutes"],
          [remaining.seconds, "Seconds"],
        ].map(([value, unit]) => (
          <span className="countdown-unit" key={unit}>
            <strong>{String(value).padStart(2, "0")}</strong>
            <small>{unit}</small>
          </span>
        ))}
      </div>
    </div>
  );
}
