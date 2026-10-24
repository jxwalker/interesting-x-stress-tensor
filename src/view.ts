/** Renderer-agnostic view interface and palette. */
import type { Model } from "./model";

export const AMBER = "#ffad33";
export const CYAN = "#3fd8ff";
export const GOLD = "#ffd36e";
export const RED = "#c4281f";

export interface Layout {
  /** Hero rectangle in CSS px (the rig, card and dial are fitted into it). */
  x: number;
  y: number;
  w: number;
  h: number;
  phone: boolean;
  /** Phone or short landscape: frame the plate itself so it fills the free area. */
  compact?: boolean;
}

export type Anchor = { x: number; y: number; on: boolean };
export type Anchors = Record<string, Anchor | undefined>;

export interface View {
  readonly kind: "webgl" | "2d";
  readonly canvas: HTMLCanvasElement;
  resize(w: number, h: number, layout: Layout): void;
  render(dt: number, model: Model): void;
  /** Screen positions (CSS px) of the things the labels name. */
  anchors(): Anchors;
  /** Plate coordinates (units of a) under a screen point, or null off the plate's plane. */
  platePoint(clientX: number, clientY: number): { x: number; y: number } | null;
  /** Screen position and grab radius of the probe. */
  probeScreen(): { x: number; y: number; r: number };
  resetCamera(): void;
  /** Someone touched the scene: pause the idle drift. */
  poke(): void;
  dispose(): void;
}

/** Number formatting: one decimal, proper minus sign. */
export function f1(v: number): string {
  const r = Math.round(v * 10) / 10;
  if (Math.abs(r) < 0.05) return "0.0";
  return (r < 0 ? "−" : "") + Math.abs(r).toFixed(1);
}
export function f2(v: number): string {
  const r = Math.round(v * 100) / 100;
  if (Math.abs(r) < 0.005) return "0.00";
  return (r < 0 ? "−" : "") + Math.abs(r).toFixed(2);
}
