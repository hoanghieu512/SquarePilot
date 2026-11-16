/** A count as an English reader writes it: 283050 → "283,050". */
export function groupDigits(n: number): string {
  return Math.round(n).toLocaleString('en-US');
}
