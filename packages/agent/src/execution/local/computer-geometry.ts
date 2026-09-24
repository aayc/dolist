import { ExecutionError } from "../errors";

export interface ScreenshotGeometry {
  width: number;
  height: number;
  /** Screenshot pixels per screen point. */
  scale: number;
}

export interface Point {
  x: number;
  y: number;
}

/** Screenshot pixels per point for an image of `imageWidth` px showing a `screenWidth`-point display. */
export function computeScale(imageWidth: number, screenWidth: number): number {
  if (!(imageWidth > 0) || !(screenWidth > 0)) {
    throw new ExecutionError(`Invalid screen geometry (${imageWidth}px over ${screenWidth}pt).`);
  }
  return imageWidth / screenWidth;
}

/** Maps model coordinates (pixels of the last screenshot) to global screen points. */
export function toScreenPoint(x: number, y: number, geometry: ScreenshotGeometry): Point {
  if (!Number.isFinite(x) || !Number.isFinite(y)) {
    throw new ExecutionError(`Coordinates must be numbers, got (${x}, ${y}).`);
  }
  if (x < 0 || y < 0 || x >= geometry.width || y >= geometry.height) {
    throw new ExecutionError(
      `Coordinates (${x}, ${y}) are outside the last screenshot (${geometry.width}×${geometry.height}). Use pixel coordinates from the most recent computer_screenshot.`,
    );
  }
  const round = (value: number) => Math.round(value * 100) / 100;
  return { x: round(x / geometry.scale), y: round(y / geometry.scale) };
}

/** Maps a screen point into a screenshot's pixel space (for frame overlays). */
export function toImagePixel(point: Point, geometry: ScreenshotGeometry): Point {
  return { x: Math.round(point.x * geometry.scale), y: Math.round(point.y * geometry.scale) };
}

/** Largest scroll per call, in lines, and per synthesized wheel event (bigger deltas misbehave). */
const MAX_SCROLL_LINES = 200;
const MAX_LINES_PER_EVENT = 10;

/**
 * Splits a scroll (positive `dy` = down, positive `dx` = right, in lines) into wheel events. Wheel
 * deltas are positive for up/left, hence the sign flip.
 */
export function scrollSteps(dx: number, dy: number): { dx: number; dy: number }[] {
  const clampTotal = (value: number) =>
    Math.max(-MAX_SCROLL_LINES, Math.min(MAX_SCROLL_LINES, Math.round(value)));
  let restX = -clampTotal(dx);
  let restY = -clampTotal(dy);
  const steps: { dx: number; dy: number }[] = [];
  while (restX !== 0 || restY !== 0) {
    const stepX = Math.max(-MAX_LINES_PER_EVENT, Math.min(MAX_LINES_PER_EVENT, restX));
    const stepY = Math.max(-MAX_LINES_PER_EVENT, Math.min(MAX_LINES_PER_EVENT, restY));
    steps.push({ dx: stepX || 0, dy: stepY || 0 });
    restX -= stepX;
    restY -= stepY;
  }
  return steps;
}
