/** Converts the "15m" / "24h" / "7d" strings used in env config to seconds. */
const UNIT_SECONDS = { s: 1, m: 60, h: 3600, d: 86_400 } as const;

export function durationToSeconds(value: string): number {
  const match = /^(\d+)([smhd])$/.exec(value);
  if (!match) throw new Error(`invalid duration "${value}" (expected e.g. 15m, 24h, 7d)`);
  return Number(match[1]) * UNIT_SECONDS[match[2] as keyof typeof UNIT_SECONDS];
}
