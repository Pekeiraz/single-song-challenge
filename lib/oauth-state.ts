import crypto from "node:crypto";
import { config } from "@/lib/config";

export type OAuthProvider = "spotify" | "youtube";
export type OAuthState = { provider: OAuthProvider; challengeId: string; playlistId: string; nonce: string; iat: number; exp: number };

const usedNonces = new Map<string, number>();

export function createOAuthState(payload: OAuthState) {
  const encoded = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const signature = crypto.createHmac("sha256", config.participantKeySecret).update(encoded).digest("base64url");
  return `${encoded}.${signature}`;
}

export function readOAuthState(value: string, provider: OAuthProvider): OAuthState | null {
  const [encoded, signature] = value.split(".");
  if (!encoded || !signature) return null;
  const expected = crypto.createHmac("sha256", config.participantKeySecret).update(encoded).digest("base64url");
  const actualBuffer = Buffer.from(signature);
  const expectedBuffer = Buffer.from(expected);
  if (actualBuffer.length !== expectedBuffer.length || !crypto.timingSafeEqual(actualBuffer, expectedBuffer)) return null;
  try {
    const state = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as Partial<OAuthState>;
    if (state.provider !== provider || typeof state.challengeId !== "string" || typeof state.playlistId !== "string" || typeof state.nonce !== "string" || typeof state.iat !== "number" || typeof state.exp !== "number") return null;
    if (state.exp <= Date.now() || state.iat > Date.now() + 30_000) return null;
    for (const [nonce, expiresAt] of usedNonces) if (expiresAt <= Date.now()) usedNonces.delete(nonce);
    if (usedNonces.has(state.nonce)) return null;
    usedNonces.set(state.nonce, state.exp);
    return state as OAuthState;
  } catch {
    return null;
  }
}