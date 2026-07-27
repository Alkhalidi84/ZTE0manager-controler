import CryptoJS from 'crypto-js';

/**
 * Thin wrappers over the hashes the ZTE firmware uses. Kept in one place so the
 * exact primitives are auditable and swappable if a firmware differs.
 */

export function md5(input: string): string {
  return CryptoJS.MD5(input).toString(CryptoJS.enc.Hex);
}

export function sha256(input: string): string {
  return CryptoJS.SHA256(input).toString(CryptoJS.enc.Hex);
}

export function md5Upper(input: string): string {
  return md5(input).toUpperCase();
}

export function sha256Upper(input: string): string {
  return sha256(input).toUpperCase();
}

/**
 * Base64 of the raw UTF-8 bytes — the password encoding of legacy ZTE login
 * (firmwares whose `WEB_ATTR_IF_SUPPORT_SHA256` is absent/0). Uses CryptoJS so
 * it behaves identically in browsers, Electron and Node (tests).
 */
export function toBase64(input: string): string {
  return CryptoJS.enc.Utf8.parse(input).toString(CryptoJS.enc.Base64);
}
