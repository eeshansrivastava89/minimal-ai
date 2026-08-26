import pc from "picocolors";

export const theme = {
  brand: pc.cyan,
  accent: pc.magenta,
  success: pc.green,
  warning: pc.yellow,
  error: pc.red,
  subtle: pc.dim,
  body: (s) => String(s ?? ""),
  bold: pc.bold,
};

export const icons = {
  check: "✓",
  cross: "✗",
  warning: "!",
  info: "→",
  bullet: "•",
  radioOn: "◉",
  radioOff: "○",
};
