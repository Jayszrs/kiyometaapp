// k-anonymity check against the Have I Been Pwned password corpus.
//
// This is the same mechanism Supabase's paid "leaked password protection"
// toggle wraps: the client sends only the first 5 hex chars of the password's
// SHA-1, HIBP returns the list of matching suffix hashes, and the check is
// done locally. The full hash and the password never leave this device.
//
// Returns the number of breaches the password appears in, or -1 when the
// range service cannot be reached. Callers treat -1 as fail-open (never lock
// an operator out because HIBP is down). Requires a secure context, so it
// silently fails open on plain-HTTP LAN access; production HTTPS works.
const kRangeUrl = "https://api.pwnedpasswords.com/range/";

export async function passwordBreachCount(password: string): Promise<number> {
  try {
    const digest = await crypto.subtle.digest("SHA-1", new TextEncoder().encode(password));
    const hex = Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, "0"))
      .join("")
      .toUpperCase();
    const response = await fetch(`${kRangeUrl}${hex.slice(0, 5)}`, { signal: AbortSignal.timeout(6000) });
    if (!response.ok) return -1;
    const suffix = hex.slice(5);
    const body = await response.text();
    for (const line of body.split("\n")) {
      const [candidate, count] = line.split(":");
      if (candidate === suffix) return Number(count || 0);
    }
    return 0;
  } catch {
    return -1;
  }
}