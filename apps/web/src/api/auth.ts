/**
 * How this page authenticates to the daemon, from what the daemon put in index.html:
 *
 * - `token`: a loopback page carries the bearer token in `<meta name="ddl-token">`;
 * - `cookie`: a page on a remote host whose browser holds a paired device's HttpOnly cookie
 *   (`<meta name="ddl-auth" content="cookie">`): no Authorization header, no token anywhere;
 * - `pairing`: a page on a remote host that must pair first (`content="pairing"`);
 * - `none`: no meta tag (the Vite dev server's proxy adds the header itself).
 */
export type PageAuth =
  | { kind: "token"; token: string }
  | { kind: "cookie" }
  | { kind: "pairing" }
  | { kind: "none" };

export function readPageAuth(doc: Document | undefined = globalThis.document): PageAuth {
  const meta = (name: string) =>
    doc?.querySelector<HTMLMetaElement>(`meta[name="${name}"]`)?.content?.trim() ?? "";
  const token = meta("ddl-token");
  if (token) return { kind: "token", token };
  const auth = meta("ddl-auth");
  if (auth === "cookie") return { kind: "cookie" };
  if (auth === "pairing") return { kind: "pairing" };
  return { kind: "none" };
}
