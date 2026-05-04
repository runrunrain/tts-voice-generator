import crypto from "node:crypto";

const TOKEN_PREFIX = "lpt_";

export interface GeneratedLocalPluginToken {
  token: string;
  hash: string;
  fingerprint: string;
}

export function generateLocalPluginToken(): GeneratedLocalPluginToken {
  const token = `${TOKEN_PREFIX}${base64Url(crypto.randomBytes(32))}`;
  return { token, hash: hashLocalPluginToken(token), fingerprint: fingerprintLocalPluginToken(token) };
}

export function hashLocalPluginToken(token: string): string {
  const digest = crypto.createHash("sha256").update(token, "utf8").digest("base64url");
  return `sha256:${digest}`;
}

export function verifyLocalPluginToken(token: string, storedHash: string | null | undefined): boolean {
  if (!storedHash || !token.startsWith(TOKEN_PREFIX)) return false;
  const actual = Buffer.from(hashLocalPluginToken(token));
  const expected = Buffer.from(storedHash);
  if (actual.length !== expected.length) return false;
  return crypto.timingSafeEqual(actual, expected);
}

export function fingerprintFromHash(storedHash: string | null | undefined): string | null {
  if (!storedHash) return null;
  const digest = storedHash.includes(":") ? storedHash.split(":").slice(1).join(":") : storedHash;
  return `sha256:${digest.slice(0, 8)}...${digest.slice(-8)}`;
}

function fingerprintLocalPluginToken(token: string): string {
  return fingerprintFromHash(hashLocalPluginToken(token))!;
}

function base64Url(bytes: Buffer): string {
  return bytes.toString("base64url");
}
