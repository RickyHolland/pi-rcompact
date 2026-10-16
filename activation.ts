/** Cost-aware activation for the long captured-request compaction ask. */
export function capturedActivation(model: any, patterns?: string[]): { enabled: boolean; reason?: string } {
  if (patterns !== undefined) {
    if (!Array.isArray(patterns) || patterns.some(p => typeof p !== "string" || !p)) {
      return { enabled: false, reason: "invalid compaction model matcher" };
    }
    const names = [String(model?.id ?? ""), `${model?.provider ?? ""}/${model?.id ?? ""}`];
    const matches = patterns.some(pattern => {
      // Deliberately small glob language: * and ?, with all regex metacharacters escaped.
      const source = [...pattern].map(c => c === "*" ? ".*" : c === "?" ? "." : c.replace(/[\\^$+.[\]{}()|]/g, "\\$&")).join("");
      return names.some(name => new RegExp(`^${source}$`, "i").test(name));
    });
    return matches ? { enabled: true } : { enabled: false, reason: "model does not match compaction models" };
  }
  return model?.cost?.input === 0 && model?.cost?.cacheRead === 0
    ? { enabled: true }
    : { enabled: false, reason: "captured-request compaction requires free input and cached input, or an explicit model matcher" };
}
