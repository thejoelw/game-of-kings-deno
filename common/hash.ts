import { crypto } from "@std/crypto/crypto";

export const hash = (data: Uint8Array) => {
  return new Uint8Array(crypto.subtle.digestSync('SHA3-256', data))
};
