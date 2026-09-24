/**
 * Bearer token for the daemon. In production the daemon injects `<meta name="ddl-token">` into the
 * served index.html; in development the Vite proxy adds the header itself, so there is no meta tag.
 */
export function readInjectedToken(doc: Document | undefined = globalThis.document): string | null {
  const content = doc?.querySelector<HTMLMetaElement>('meta[name="ddl-token"]')?.content?.trim();
  return content ? content : null;
}
