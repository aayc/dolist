interface NavigatorUAData {
  platform?: string;
}

function detectMac(): boolean {
  if (typeof navigator === "undefined") return false;
  const nav = navigator as Navigator & { userAgentData?: NavigatorUAData };
  const platform = nav.userAgentData?.platform || nav.platform || nav.userAgent || "";
  return /mac|iphone|ipad|ipod/i.test(platform);
}

/** Apple platforms use ⌘ as the primary modifier ("Mod"); everything else uses Ctrl. */
export const IS_MAC: boolean = detectMac();

export function searchParam(name: string): string | null {
  if (typeof location === "undefined") return null;
  return new URLSearchParams(location.search).get(name);
}
