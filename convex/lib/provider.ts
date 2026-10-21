import { limitFromEntitlements, UNLIMITED, type LimitRead } from "./core";

/** The plan limit and the usage meter come from Kinde when PROVIDER is "kinde". Otherwise a built-in stand-in is used and nothing leaves Convex. */
export const providerIsKinde = (): boolean => process.env.PROVIDER === "kinde";

export interface KindeTarget {
  customerId?: string;
  agreementId?: string;
  featureCode: string;
}

const domain = () => (process.env.KINDE_DOMAIN ?? "").replace(/\/$/, "");

let cached: { token: string; expiresAt: number } | null = null;

/** A Kinde management token from a machine-to-machine app. It needs the read:billing_entitlements and create:meter_usage scopes. */
async function managementToken(): Promise<string> {
  if (cached && cached.expiresAt - 60_000 > Date.now()) return cached.token;
  const response = await fetch(`${domain()}/oauth2/token`, {
    signal: AbortSignal.timeout(10_000),
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "client_credentials",
      client_id: process.env.KINDE_M2M_CLIENT_ID ?? "",
      client_secret: process.env.KINDE_M2M_CLIENT_SECRET ?? "",
      audience: `${domain()}/api`,
    }),
  });
  if (!response.ok) throw new Error(`Kinde refused the machine token (${response.status}).`);
  const body = (await response.json()) as { access_token: string; expires_in?: number };
  cached = { token: body.access_token, expiresAt: Date.now() + (body.expires_in ?? 3600) * 1000 };
  return cached.token;
}

async function api(path: string, init?: RequestInit, retried = false): Promise<Response> {
  const response = await fetch(`${domain()}/api/v1${path}`, {
    ...init,
    headers: { authorization: `Bearer ${await managementToken()}`, "content-type": "application/json", ...init?.headers },
    signal: AbortSignal.timeout(10_000),
  });
  if (response.status === 429) throw new Error("Kinde is rate limiting this app (429).");
  // A token made before a scope was added keeps the old scopes. Fetch a new one once.
  if (response.status === 403 && !retried) {
    cached = null;
    return api(path, init, true);
  }
  if (!response.ok) {
    const detail = (await response.text().catch(() => "")).replace(/\s+/g, " ").slice(0, 200);
    throw new Error(`Kinde answered ${response.status}${detail ? `: ${detail}` : "."}`);
  }
  return response;
}

/**
 * The customer's maximum for the feature, from their entitlements.
 * Any failure is "unreadable". The caller then decides whether the last known limit is still good enough.
 */
export async function readKindeLimit(target: KindeTarget): Promise<LimitRead> {
  if (!target.customerId) return { kind: "unreadable" };
  try {
    const query = new URLSearchParams({ customer_id: target.customerId, page_size: "100", max_value: String(UNLIMITED) });
    const response = await api(`/billing/entitlements?${query}`);
    const limit = limitFromEntitlements(await response.json(), target.featureCode);
    return limit === null ? { kind: "unreadable" } : { kind: "fresh", limit };
  } catch {
    return { kind: "unreadable" };
  }
}

/** Set the usage total on Kinde's meter. This is an absolute write: sending it twice leaves the same total. */
export async function sendKindeTotal(target: KindeTarget, value: number): Promise<void> {
  if (!target.agreementId) throw new Error("No Kinde agreement is set for this account.");
  await api("/billing/meter_usage", {
    method: "POST",
    body: JSON.stringify({
      customer_agreement_id: target.agreementId,
      billing_feature_code: target.featureCode,
      meter_value: String(value),
      meter_type_code: "absolute",
    }),
  });
}
