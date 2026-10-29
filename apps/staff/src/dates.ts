/** Today's date ("yyyy-MM-dd") at the course, whatever time zone the device is in. */
export function todayIn(timeZone: string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(
    new Date(),
  );
}

export function addDays(date: string, days: number): string {
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export function formatDate(date: string): string {
  return new Date(`${date}T12:00:00Z`).toLocaleDateString("en-US", {
    weekday: "long",
    month: "long",
    day: "numeric",
    timeZone: "UTC",
  });
}

/** Current local "HH:mm" at the course, used to highlight the next tee time. */
export function nowIn(timeZone: string): string {
  return new Intl.DateTimeFormat("en-GB", { timeZone, hour: "2-digit", minute: "2-digit", hour12: false }).format(
    new Date(),
  );
}

/** The Monday on or before a date, so the week strip always runs Monday to Sunday. */
export function weekStart(date: string): string {
  const day = new Date(`${date}T12:00:00Z`).getUTCDay(); // 0 = Sunday
  return addDays(date, -((day + 6) % 7));
}

/** "Mon" and "18" for the week strip. */
export function dayParts(date: string): { weekday: string; day: string; long: string } {
  const d = new Date(`${date}T12:00:00Z`);
  return {
    weekday: d.toLocaleDateString("en-US", { weekday: "short", timeZone: "UTC" }),
    day: String(d.getUTCDate()),
    long: formatDate(date),
  };
}
