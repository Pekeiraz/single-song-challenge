import crypto from "node:crypto";
import { config } from "@/lib/config";

export function participantKey(provider: "spotify" | "youtube" | "tidal", providerUserId: string, challengeId: string) {
  return crypto
    .createHmac("sha256", config.participantKeySecret)
    .update(`${provider}:${challengeId}:${providerUserId}`)
    .digest("hex");
}
