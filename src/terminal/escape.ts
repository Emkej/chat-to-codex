/** Escape input controls without losing LF boundaries or confusing literal backslashes. */
export function escapeTerminalText(value: string, preserveNewlines = false): string {
  return Array.from(value, (character) => {
    const code = character.codePointAt(0)!;
    if (preserveNewlines && character === "\n") return character;
    if (character === "\\") return "\\\\";
    if (code < 32 || (code >= 127 && code <= 159) || /[\p{Cf}\p{Zl}\p{Zp}]/u.test(character)) {
      return "\\u{" + code.toString(16).padStart(4, "0") + "}";
    }
    return character;
  }).join("");
}

/** Machine-readable JSON that also cannot inject terminal controls or bidi formatting. */
export function terminalSafeJson(value: unknown): string {
  return JSON.stringify(value).replace(/[\u007f-\u009f\p{Cf}\p{Zl}\p{Zp}]/gu, (character) =>
    Array.from({ length: character.length }, (_, i) => "\\u" + character.charCodeAt(i).toString(16).padStart(4, "0")).join(""));
}
