/**
 * What to call this browser when it pairs, from its user agent: "Chrome on macOS", "Safari on
 * iPhone". iPadOS Safari says it's a Mac; `touch` (more than one touch point) tells them apart.
 */
export function defaultBrowserName(userAgent: string, touch = false): string {
  const browser = /Edg(?:e|A|iOS)?\//.test(userAgent)
    ? "Edge"
    : /OPR\/|Opera/.test(userAgent)
      ? "Opera"
      : /Firefox\/|FxiOS\//.test(userAgent)
        ? "Firefox"
        : /Chrome\/|CriOS\/|Chromium\//.test(userAgent)
          ? "Chrome"
          : /Safari\//.test(userAgent)
            ? "Safari"
            : "Browser";
  const os = /iPhone/.test(userAgent)
    ? "iPhone"
    : /iPad/.test(userAgent)
      ? "iPad"
      : /Android/.test(userAgent)
        ? "Android"
        : /CrOS/.test(userAgent)
          ? "ChromeOS"
          : /Macintosh|Mac OS X/.test(userAgent)
            ? touch
              ? "iPad"
              : "macOS"
            : /Windows/.test(userAgent)
              ? "Windows"
              : /Linux/.test(userAgent)
                ? "Linux"
                : "";
  return os ? `${browser} on ${os}` : browser;
}

export function thisBrowserName(): string {
  if (typeof navigator === "undefined") return "Browser";
  return defaultBrowserName(navigator.userAgent, navigator.maxTouchPoints > 1);
}
