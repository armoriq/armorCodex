/**
 * The CLI writes `~/.armoriq/credentials.json` as a versioned document with one
 * profile per product and backend. Older files held a single top-level key.
 * A plugin that only understands the old shape finds no key, starts
 * unconfigured and silently stops reporting, so both shapes are read here.
 */
export function credentialFor(creds, { backend, product }) {
  const empty = { apiKey: "", orgId: "" };
  if (!creds || typeof creds !== "object") return empty;

  if (creds.version === 2) {
    const profiles = creds.profiles;
    if (!profiles || typeof profiles !== "object") return empty;
    const wanted = originOf(backend);
    const match =
      Object.entries(profiles).find(
        ([, p]) => p?.product === product && originOf(p?.backend) === wanted
      ) ?? [];
    const profile = match[1];
    return {
      apiKey: typeof profile?.apiKey === "string" ? profile.apiKey : "",
      orgId: typeof profile?.orgId === "string" ? profile.orgId : "",
    };
  }

  return {
    apiKey: typeof creds.apiKey === "string" ? creds.apiKey : "",
    orgId: typeof creds.orgId === "string" ? creds.orgId : "",
  };
}

function originOf(value) {
  if (typeof value !== "string" || value === "") return "";
  try {
    return new URL(value).origin;
  } catch {
    return "";
  }
}
