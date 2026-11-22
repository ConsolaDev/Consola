/**
 * The CLI's estimate of what a turn cost, as every surface shows it: 4
 * decimals below $1, 2 from $1, then " est.". It is the CLI's figure, not
 * a bill, so it always says so.
 */
export function formatCostUsd(usd: number): string {
  return `$${usd.toFixed(usd < 1 ? 4 : 2)} est.`;
}
