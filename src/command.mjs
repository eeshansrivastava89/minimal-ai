export function buildPrettyCommand(profile, binary = "llama-server") {
  const argv = profile.commandArgv ?? [];
  const lines = [`${quoteShell(binary)} \\`];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = argv[i + 1];
    const hasValue = arg.startsWith("--") && next && !next.startsWith("--");
    if (hasValue) {
      lines.push(`  ${arg} ${quoteShell(next)}${i + 2 < argv.length ? " \\" : ""}`);
      i += 1;
    } else {
      lines.push(`  ${arg}${i + 1 < argv.length ? " \\" : ""}`);
    }
  }
  return lines.join("\n");
}

export function quoteShell(value) {
  const text = String(value);
  return /^[A-Za-z0-9_/@%+=:,.-]+$/u.test(text) ? text : `'${text.replace(/'/gu, `'"'"'`)}'`;
}
