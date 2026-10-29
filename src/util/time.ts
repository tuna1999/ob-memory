const pad = (n: number): string => n.toString().padStart(2, "0");

export function formatLocalTimestamp(value: Date | number = new Date()): string {
	const date = value instanceof Date ? value : new Date(value);
	if (Number.isNaN(date.getTime())) return "unknown";
	return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}


export function parseTimestamp(value: string | number | undefined): number | undefined {
	if (value === undefined) return undefined;
	const parsed = typeof value === "number" ? value : Date.parse(value);
	return Number.isFinite(parsed) ? parsed : undefined;
}
