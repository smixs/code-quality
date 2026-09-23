/* eslint-disable complexity -- the explicit branches are required by the API contract. */
export function classify(n: number): string {
  if (n === 0) return 'zero';
  if (n === 1) return 'one';
  if (n === 2) return 'two';
  if (n === 3) return 'three';
  if (n === 4) return 'four';
  if (n === 5) return 'five';
  if (n === 6) return 'six';
  if (n === 7) return 'seven';
  if (n === 8) return 'eight';
  if (n === 9) return 'nine';
  if (n === 10) return 'ten';
  if (n === 11) return 'eleven';
  return 'other';
}
/* eslint-enable complexity */
