// Responsibility: UUID version 7 ids, made on the client (ADR 0016).
// 48 bits of Unix milliseconds, then a 12-bit counter, then 62 random
// bits. An id made later sorts later as a string. Ids made in one
// millisecond count up from a random start, so they sort in the order they
// were made, and the counter has room for 2048 ids before the millisecond
// moves on by itself.
// Boundary: globalThis.crypto only, so Workers and Node share this file.
// Nothing here knows about tables; index.ts brands the string.

let lastMs = -1;
let counter = 0;

export function uuidV7(now: number = Date.now()): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  let ms = Math.max(Math.floor(now), lastMs);
  if (ms === lastMs) {
    counter += 1;
    if (counter > 0xfff) {
      counter = 0;
      ms += 1;
    }
  } else {
    // A random start below 0x800 leaves the top bit of the counter free.
    counter = ((bytes[6]! << 8) | bytes[7]!) & 0x7ff;
  }
  lastMs = ms;
  let rest = ms;
  for (let i = 5; i >= 0; i--) {
    bytes[i] = rest % 256;
    rest = Math.floor(rest / 256);
  }
  bytes[6] = 0x70 | (counter >> 8);
  bytes[7] = counter & 0xff;
  bytes[8] = 0x80 | (bytes[8]! & 0x3f);
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
