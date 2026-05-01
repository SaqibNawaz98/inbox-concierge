import { createHash } from "crypto";

/**
 * Stable pseudonymous key for the signed-in Google account (from refresh token).
 * Used to partition training rows; not reversible to the token.
 */
export function accountKeyFromRefreshToken(refreshToken: string): string {
  return createHash("sha256").update(refreshToken, "utf8").digest("hex").slice(0, 32);
}
