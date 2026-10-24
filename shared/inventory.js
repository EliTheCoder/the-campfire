import { INV_SIZE } from './constants.js';
import { stackMax } from './defs.js';

export const newInv = () => new Array(INV_SIZE).fill(null);

export function countItem(inv, item) {
  let n = 0;
  for (const s of inv) if (s && s.item === item) n += s.n;
  return n;
}

// Returns how many could NOT be added.
export function addItem(inv, item, n) {
  const max = stackMax(item);
  for (const s of inv) {
    if (n <= 0) break;
    if (s && s.item === item && s.n < max) { const a = Math.min(n, max - s.n); s.n += a; n -= a; }
  }
  for (let i = 0; i < inv.length && n > 0; i++) {
    if (!inv[i]) { const a = Math.min(n, max); inv[i] = { item, n: a }; n -= a; }
  }
  return n;
}

export function removeItem(inv, item, n) {
  for (let i = inv.length - 1; i >= 0 && n > 0; i--) {
    const s = inv[i];
    if (s && s.item === item) { const a = Math.min(n, s.n); s.n -= a; n -= a; if (s.n <= 0) inv[i] = null; }
  }
  return n === 0;
}

export function hasAll(inv, req) {
  for (const [item, n] of Object.entries(req)) if (countItem(inv, item) < n) return false;
  return true;
}
