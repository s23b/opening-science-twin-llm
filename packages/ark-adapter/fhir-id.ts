/** Deterministic resource identities for the public Ark export format. */
import { createHash } from "node:crypto";

/** Computes UUIDv5 in the URL namespace over a resource path without a leading slash. */
export const fhirId = (path: string): string => {
  const hash = createHash("sha1")
    .update(Buffer.from("6ba7b8119dad11d180b400c04fd430c8", "hex"))
    .update(path)
    .digest()
    .subarray(0, 16);
  hash[6] = (hash[6]! & 0x0f) | 0x50;
  hash[8] = (hash[8]! & 0x3f) | 0x80;
  const hex = hash.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
};
