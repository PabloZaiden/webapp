export function DateTimeValue({ value }: { value: string }) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return <span>Invalid date</span>;
  return <time dateTime={value} title={date.toLocaleString()}>{new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(date)}</time>;
}
