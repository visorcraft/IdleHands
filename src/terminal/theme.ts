import chalk, { Chalk } from "chalk";
import { HAND_PALETTE } from "./palette.js";

const hasForceColor =
  typeof process.env.FORCE_COLOR === "string" &&
  process.env.FORCE_COLOR.trim().length > 0 &&
  process.env.FORCE_COLOR.trim() !== "0";

const baseChalk = process.env.NO_COLOR && !hasForceColor ? new Chalk({ level: 0 }) : chalk;

const hex = (value: string) => baseChalk.hex(value);

export const theme = {
  accent: hex(HAND_PALETTE.accent),
  accentBright: hex(HAND_PALETTE.accentBright),
  accentDim: hex(HAND_PALETTE.accentDim),
  info: hex(HAND_PALETTE.info),
  success: hex(HAND_PALETTE.success),
  warn: hex(HAND_PALETTE.warn),
  error: hex(HAND_PALETTE.error),
  muted: hex(HAND_PALETTE.muted),
  heading: baseChalk.bold.hex(HAND_PALETTE.accent),
  command: hex(HAND_PALETTE.accentBright),
  option: hex(HAND_PALETTE.warn),
} as const;

export const isRich = () => Boolean(baseChalk.level > 0);

export const colorize = (rich: boolean, color: (value: string) => string, value: string) =>
  rich ? color(value) : value;
