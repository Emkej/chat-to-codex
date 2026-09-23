import { createHash } from "node:crypto";
import type { Response } from "express";

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function normalizeFormActionOrigin(value: string): string | null {
  try {
    const origin = new URL(value);
    if (origin.protocol === "https:") return origin.origin;
    if (origin.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(origin.hostname)) {
      return origin.origin;
    }
  } catch {
    // Keep the restrictive `'self'` fallback for malformed or unsupported origins.
  }
  return null;
}

function normalizeFormActionOrigins(values: string[]): string[] {
  return [...new Set(values.map(normalizeFormActionOrigin).filter((value): value is string => value !== null))];
}

/**
 * Allow one specific inline script via CSP hash. Anything else stays blocked
 * by `default-src 'none'`. OAuth clients may render the pairing page through
 * a browser relay, so the authorization server and registered callback origins
 * are explicitly allowed as form targets as well.
 */
export function setAuthSecurityHeaders(
  res: Response,
  opts: { script?: string; formActionOrigin?: string; formActionOrigins?: string[] } = {}
): void {
  const scriptSrc = opts.script
    ? `script-src 'sha256-${createHash("sha256").update(opts.script).digest("base64")}';`
    : "";
  const formActionOrigins = normalizeFormActionOrigins([
    ...(opts.formActionOrigins ?? []),
    ...(opts.formActionOrigin ? [opts.formActionOrigin] : []),
  ]);
  const formAction = formActionOrigins.length > 0
    ? `form-action 'self' ${formActionOrigins.join(" ")}`
    : "form-action 'self'";
  const policy = [
    "default-src 'none'",
    "style-src 'unsafe-inline'",
    scriptSrc.replace(/;$/, ""),
    formAction,
    "base-uri 'none'",
    "frame-ancestors 'none'",
  ]
    .filter(Boolean)
    .join("; ");
  res.setHeader(
    "Content-Security-Policy",
    policy
  );
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("Cache-Control", "no-store, max-age=0");
}
