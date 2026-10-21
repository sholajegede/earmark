import { createRemoteJWKSet, jwtVerify } from "jose";

/** Sign-in: the website uses Kinde's session, and the API accepts a Kinde access token as a Bearer token. */

export const issuer = () => (process.env.KINDE_ISSUER_URL ?? "").replace(/\/$/, "");
export const kindeReady = () => Boolean(issuer() && process.env.KINDE_CLIENT_ID);

let keys: ReturnType<typeof createRemoteJWKSet> | undefined;
/** The signing keys a Kinde domain publishes. They are fetched once and cached by jose. */
const jwks = () => (keys ??= createRemoteJWKSet(new URL(`${issuer()}/.well-known/jwks`)));

/** Check a Kinde access token. Returns the user id. */
export async function verifyAccessToken(token: string): Promise<string> {
  const { payload } = await jwtVerify(token, jwks(), { issuer: issuer() });
  if (!payload.sub) throw new Error("The token has no subject.");
  return payload.sub;
}
