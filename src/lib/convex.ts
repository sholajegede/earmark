import { ConvexHttpClient } from "convex/browser";

/** The server key lets this website, and nothing else, read and write jobs and budgets. */
export const serverKey = (): string => {
  const key = process.env.EARMARK_SERVER_KEY;
  if (!key) throw new Error("EARMARK_SERVER_KEY is not set. Run: npm run setup");
  return key;
};

export const convex = (): ConvexHttpClient => {
  const url = process.env.NEXT_PUBLIC_CONVEX_URL;
  if (!url) throw new Error("NEXT_PUBLIC_CONVEX_URL is not set. Run: npm run setup");
  return new ConvexHttpClient(url);
};

/** The plan limit and the meter are a built-in stand-in unless Kinde is chosen. Only the stand-in can run the unsafe mode of the lab. */
export const builtin = (): boolean => process.env.PROVIDER !== "kinde";
