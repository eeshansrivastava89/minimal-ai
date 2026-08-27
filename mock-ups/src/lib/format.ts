// Formatting helpers — pure functions, no components.

export function fmtBytes(b: number | null | undefined): string {
  if (b == null || !Number.isFinite(b)) return "—";
  const u = ["B", "KB", "MB", "GB", "TB"];
  let i = 0;
  let v = b;
  while (v >= 1024 && i < u.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(i === 0 ? 0 : 1)} ${u[i]}`;
}

export function fmtDate(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return (
    d.toLocaleDateString("en-US", { month: "short", day: "numeric" }) +
    " " +
    d.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" })
  );
}

export function fmtDur(ms: number | null | undefined): string {
  if (ms == null) return "—";
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(0)}s`;
  const m = Math.floor(s / 60);
  return `${m}m ${Math.round(s % 60)}s`;
}

export function fmtTps(v: number | null | undefined): string {
  return v == null ? "—" : `${v.toFixed(1)} tps`;
}

export function fmtPct(v: number | null | undefined): string {
  return v == null ? "—" : `${v.toFixed(1)}%`;
}

export function fmtCtx(v: number | null | undefined): string {
  return v == null ? "—" : v.toLocaleString();
}

export function backendLabel(id: string): string {
  return (
    { "llama-cpp": "llama.cpp", omlx: "oMLX", ollama: "Ollama" }[id] ?? id
  );
}
