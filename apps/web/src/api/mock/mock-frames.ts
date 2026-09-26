/**
 * Synthetic "screencast" frames for the mock agent: a fake web page (browser surface) or a fake
 * desktop (computer surface), drawn on a canvas and encoded as JPEG like the real daemon streams.
 */

export interface BrowserPage {
  url: string;
  title: string;
  site: string;
  query?: string;
  items: Array<{ title: string; meta: string; price?: string }>;
  /** Index of the item being interacted with; -1 = the search box. */
  focus?: number;
  button?: string;
  focusButton?: boolean;
}

export interface DesktopScene {
  app: string;
  files: string[];
  selected?: number;
}

export interface FrameImage {
  mimeType: "image/jpeg";
  data: string;
  width: number;
  height: number;
}

const WIDTH = 960;
const HEIGHT = 600;
/** 1×1 grey JPEG used where canvas is unavailable (unit tests). */
const FALLBACK_JPEG =
  "/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA=";

let canvas: HTMLCanvasElement | null = null;

function context(): CanvasRenderingContext2D | null {
  if (typeof document === "undefined") return null;
  canvas ??= document.createElement("canvas");
  canvas.width = WIDTH;
  canvas.height = HEIGHT;
  try {
    return canvas.getContext("2d");
  } catch {
    return null;
  }
}

function encode(ctx: CanvasRenderingContext2D | null): FrameImage {
  if (!ctx || !canvas) return { mimeType: "image/jpeg", data: FALLBACK_JPEG, width: 1, height: 1 };
  const url = canvas.toDataURL("image/jpeg", 0.72);
  const data = url.slice(url.indexOf(",") + 1);
  return { mimeType: "image/jpeg", data, width: WIDTH, height: HEIGHT };
}

function hue(text: string): number {
  let h = 0;
  for (let i = 0; i < text.length; i++) h = (h * 31 + text.charCodeAt(i)) % 360;
  return h;
}

function roundRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
) {
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, r);
}

function drawCursor(ctx: CanvasRenderingContext2D, x: number, y: number, tick: number) {
  const pulse = 10 + (tick % 4) * 3;
  ctx.strokeStyle = "rgba(59, 139, 255, 0.55)";
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.arc(x, y, pulse, 0, Math.PI * 2);
  ctx.stroke();
  ctx.fillStyle = "#3b8bff";
  ctx.beginPath();
  ctx.arc(x, y, 5, 0, Math.PI * 2);
  ctx.fill();
}

const ITEM_TOP = 156;
const ITEM_HEIGHT = 92;
const ITEM_GAP = 14;

/** Center of the element the agent is acting on, in frame pixels. */
export function browserFocusPoint(page: BrowserPage): { x: number; y: number } | null {
  if (page.focusButton && page.button) {
    const y = ITEM_TOP + page.items.length * (ITEM_HEIGHT + ITEM_GAP) + 26;
    return { x: WIDTH - 48 - 110, y };
  }
  if (page.focus === undefined) return null;
  if (page.focus === -1) return { x: WIDTH / 2, y: 108 };
  return { x: WIDTH / 2, y: ITEM_TOP + page.focus * (ITEM_HEIGHT + ITEM_GAP) + ITEM_HEIGHT / 2 };
}

export function renderBrowserFrame(page: BrowserPage, tick: number): FrameImage {
  const ctx = context();
  if (!ctx) return encode(null);
  const h = hue(page.site);
  ctx.fillStyle = "#f7f7f8";
  ctx.fillRect(0, 0, WIDTH, HEIGHT);

  ctx.fillStyle = `hsl(${h} 55% 42%)`;
  ctx.fillRect(0, 0, WIDTH, 64);
  ctx.fillStyle = "#fff";
  ctx.font = "600 24px system-ui, sans-serif";
  ctx.fillText(page.site, 32, 41);
  ctx.font = "15px system-ui, sans-serif";
  ctx.fillText("Deals    Help    Account", WIDTH - 230, 40);

  roundRect(ctx, 48, 88, WIDTH - 96, 40, 20);
  ctx.fillStyle = "#fff";
  ctx.fill();
  ctx.strokeStyle = page.focus === -1 ? "#3b8bff" : "#d4d4d8";
  ctx.lineWidth = page.focus === -1 ? 3 : 1;
  ctx.stroke();
  ctx.fillStyle = "#3f3f46";
  ctx.font = "16px system-ui, sans-serif";
  ctx.fillText(page.query ?? "Search", 68, 114);

  page.items.forEach((item, i) => {
    const y = ITEM_TOP + i * (ITEM_HEIGHT + ITEM_GAP);
    roundRect(ctx, 48, y, WIDTH - 96, ITEM_HEIGHT, 12);
    ctx.fillStyle = "#fff";
    ctx.fill();
    ctx.strokeStyle = page.focus === i ? "#3b8bff" : "#e4e4e7";
    ctx.lineWidth = page.focus === i ? 3 : 1;
    ctx.stroke();
    ctx.fillStyle = `hsl(${(h + i * 40) % 360} 45% 85%)`;
    roundRect(ctx, 64, y + 14, 64, 64, 8);
    ctx.fill();
    ctx.fillStyle = "#18181b";
    ctx.font = "600 19px system-ui, sans-serif";
    ctx.fillText(item.title, 148, y + 38);
    ctx.fillStyle = "#71717a";
    ctx.font = "15px system-ui, sans-serif";
    ctx.fillText(item.meta, 148, y + 64);
    if (item.price) {
      ctx.fillStyle = "#18181b";
      ctx.font = "700 20px system-ui, sans-serif";
      ctx.fillText(item.price, WIDTH - 150, y + 52);
    }
  });

  if (page.button) {
    const y = ITEM_TOP + page.items.length * (ITEM_HEIGHT + ITEM_GAP);
    roundRect(ctx, WIDTH - 48 - 220, y, 220, 52, 26);
    ctx.fillStyle = page.focusButton ? `hsl(${h} 60% 38%)` : `hsl(${h} 55% 45%)`;
    ctx.fill();
    ctx.fillStyle = "#fff";
    ctx.font = "600 18px system-ui, sans-serif";
    ctx.fillText(page.button, WIDTH - 48 - 200, y + 33);
  }

  const point = browserFocusPoint(page);
  if (point) drawCursor(ctx, point.x, point.y, tick);
  return encode(ctx);
}

const ROW_TOP = 142;
const ROW_HEIGHT = 34;

export function desktopFocusPoint(scene: DesktopScene): { x: number; y: number } | null {
  if (scene.selected === undefined) return null;
  return { x: 520, y: ROW_TOP + scene.selected * ROW_HEIGHT + ROW_HEIGHT / 2 };
}

export function renderDesktopFrame(scene: DesktopScene, tick: number): FrameImage {
  const ctx = context();
  if (!ctx) return encode(null);
  const gradient = ctx.createLinearGradient(0, 0, WIDTH, HEIGHT);
  gradient.addColorStop(0, "#1d3b8a");
  gradient.addColorStop(1, "#1f6f8b");
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, WIDTH, HEIGHT);

  ctx.fillStyle = "rgba(20, 20, 24, 0.75)";
  ctx.fillRect(0, 0, WIDTH, 28);
  ctx.fillStyle = "#f4f4f5";
  ctx.font = "600 14px system-ui, sans-serif";
  ctx.fillText(scene.app, 18, 19);
  ctx.font = "14px system-ui, sans-serif";
  ctx.fillText("File   Edit   View   Go   Window", 110, 19);

  roundRect(ctx, 150, 70, 660, 440, 12);
  ctx.fillStyle = "#fafafa";
  ctx.fill();
  ctx.fillStyle = "#e4e4e7";
  ctx.fillRect(150, 70, 660, 40);
  ["#ef4444", "#f59e0b", "#22c55e"].forEach((color, i) => {
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(172 + i * 20, 90, 6, 0, Math.PI * 2);
    ctx.fill();
  });
  ctx.fillStyle = "#3f3f46";
  ctx.font = "600 14px system-ui, sans-serif";
  ctx.fillText(scene.app, 440, 95);

  ctx.fillStyle = "#f1f1f3";
  ctx.fillRect(150, 110, 150, 400);
  ctx.fillStyle = "#71717a";
  ctx.font = "13px system-ui, sans-serif";
  ["Desktop", "Documents", "Downloads", "Pictures"].forEach((label, i) => {
    ctx.fillText(label, 170, 142 + i * 28);
  });

  scene.files.forEach((file, i) => {
    const y = ROW_TOP + i * ROW_HEIGHT;
    if (scene.selected === i) {
      ctx.fillStyle = "#3b8bff";
      ctx.fillRect(300, y, 510, ROW_HEIGHT);
    }
    ctx.fillStyle = scene.selected === i ? "#fff" : "#27272a";
    ctx.font = "14px system-ui, sans-serif";
    ctx.fillText(file, 330, y + 22);
  });

  roundRect(ctx, 300, HEIGHT - 70, 360, 56, 16);
  ctx.fillStyle = "rgba(255, 255, 255, 0.25)";
  ctx.fill();

  const point = desktopFocusPoint(scene);
  if (point) drawCursor(ctx, point.x, point.y, tick);
  return encode(ctx);
}
