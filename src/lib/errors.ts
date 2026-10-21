/** The first useful line of a Convex error, without the stack and the function name. */
export function cleanError(error: unknown, fallback = "Something went wrong."): string {
  if (!(error instanceof Error)) return fallback;
  const line = error.message.split("\n").find((l) => l.includes("Uncaught Error:")) ?? error.message;
  return line.replace(/^.*Uncaught Error: /, "").replace(/ at handler.*$/, "").trim() || fallback;
}
