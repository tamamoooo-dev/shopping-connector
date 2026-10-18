// Offer validity is a Saudi calendar date; timestamps and retention stay UTC.
const marketCalendar = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Riyadh', year: 'numeric', month: '2-digit', day: '2-digit',
});

export function marketDate(now = new Date()) {
  const parts = Object.fromEntries(marketCalendar.formatToParts(now).map(p => [p.type, p.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}
