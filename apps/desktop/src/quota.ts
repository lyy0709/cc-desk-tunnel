import type { NativeMetrics, UsageSummary } from '@cc-desk-tunnel/protocol';
import { useEffect, useState } from 'react';

type Limits = NativeMetrics['rateLimits'] | undefined;
// The account's quota as the service keeps it, from chat runs and terminals alike, with what a reading newer than that
// says in place of its windows: a session's events can bring one before the service is asked again. A period past its
// reset, of which nothing has been read since, is left out.
export function accountQuota(summary: UsageSummary | null, live: Limits): Limits {
  const stored: Limits =
    summary?.measuredAt && summary.windows.some((window) => window.utilization !== null)
      ? {
          available: true,
          measuredAt: summary.measuredAt,
          windows: summary.windows
            .filter((window) => window.utilization !== null)
            .map(({ name, utilization, resetsAt }) => ({ name, utilization, resetsAt })),
        }
      : null;
  if (!live?.available) return stored ?? live ?? null;
  if (!stored) return live;
  if ((live.measuredAt ?? '') <= stored.measuredAt!) return stored;
  const fresh = new Map(live.windows.map((window) => [window.name, window]));
  return {
    available: true,
    measuredAt: live.measuredAt,
    windows: [
      ...stored.windows.map((window) => fresh.get(window.name) ?? window),
      ...live.windows.filter((window) => !stored.windows.some((row) => row.name === window.name)),
    ],
  };
}
export function currentQuota(limits: Limits, now = Date.now()) {
  if (!limits?.available) return null;
  const windows = limits.windows.filter(
    (window) => !window.resetsAt || Date.parse(window.resetsAt) > now,
  );
  return windows.length ? { ...limits, windows } : null;
}

// Expire known windows while the page is idle; this timer makes no service or model request.
export function useQuota(limits: Limits) {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const future = (limits?.windows ?? [])
      .flatMap((window) => (window.resetsAt ? [Date.parse(window.resetsAt)] : []))
      .filter((at) => at > Date.now());
    if (!future.length) return;
    const timer = setTimeout(
      () => setNow(Date.now()),
      Math.min(2_147_483_647, Math.max(0, Math.min(...future) - Date.now())),
    );
    return () => clearTimeout(timer);
  }, [limits, now]);
  return currentQuota(limits, Math.max(now, Date.now()));
}

// The two figures worth a glance while writing: how much of the five-hour and of the weekly quota is used.
// A plan with a weekly quota per model has several weekly windows; the fullest is the one that stops work
// first. `seven_day_oauth_apps` limits the account's other applications, not this one.
// (The idea of the quota beside the message box: #27 and #41, hansaes.)
export function quotaFigures(limits: Limits, now = Date.now()) {
  const read = (currentQuota(limits, now)?.windows ?? []).filter(
    (window) => window.utilization !== null,
  );
  const hour = read.find((window) => window.name === 'five_hour');
  const week = read
    .filter(
      (window) => window.name.startsWith('seven_day') && window.name !== 'seven_day_oauth_apps',
    )
    .sort((a, b) => b.utilization! - a.utilization!)[0];
  return [
    ...(hour ? [{ label: '5 小时', ...hour }] : []),
    ...(week ? [{ label: '每周', ...week }] : []),
  ].map(({ label, utilization, resetsAt }) => ({
    label,
    used: Math.round(utilization!),
    resetsAt,
  }));
}
