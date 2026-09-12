export function compactResetLabel(resetsAt: number | undefined, now: number): string {
  if (resetsAt === undefined) return "—";
  const minutes = Math.ceil((resetsAt - now) / 60_000);
  if (minutes <= 0) return "0m";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours}h ${minutes % 60}m`;
  return `${Math.floor(hours / 24)}d ${hours % 24}h`;
}

export function fullResetLabel(resetsAt: number | undefined, now: number): string {
  if (resetsAt === undefined) return "Reset time unavailable";
  const remaining = resetsAt - now;
  if (remaining <= 0) return "Resetting now";
  return `Resets in ${compactResetLabel(resetsAt, now)}`;
}
