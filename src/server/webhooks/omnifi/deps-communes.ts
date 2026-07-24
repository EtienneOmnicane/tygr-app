/**
 * Dépendances CÂBLÉES partagées par les deux consommateurs du pipeline webhook :
 * la route de réception (`route-handler.ts`, W4) et le rejeu de la quarantaine
 * (`rejeu.ts`, W5). Extraites pour qu'un correctif (cross-check env, écriture
 * d'audit) s'applique aux DEUX chemins — le rejeu repasse par le pipeline complet,
 * jamais par une copie qui divergerait (plan §12 : « aucun raccourci »).
 *
 * Vit sous `src/server/webhooks/omnifi/**` : seule surface exemptée des frontières
 * FRONTIERE_SYSTEME / FRONTIERE_SERVICE (eslint) — la primitive système et le
 * client de service ne sont consommés QU'ici.
 */
import { eq } from "drizzle-orm";

import { workspaces } from "@/server/db/schema";
import { executerPourWorkspaceSysteme } from "@/server/db/systeme";
import {
  consignerEvenementWebhook,
  type EvenementWebhookAConsigner,
} from "@/server/repositories/audit";

import type { EnvOmniFi } from "./hmac";

/** Env du déploiement : « production » SSI OMNIFI_ENV vaut exactement cela, sinon sandbox. */
export function envDeploiement(): EnvOmniFi {
  return process.env.OMNIFI_ENV === "production" ? "production" : "sandbox";
}

/** Cross-check : env du workspace résolu (sous tygr_app + GUC ; workspaces sans RLS). */
export async function lireEnvWorkspace(workspaceId: string): Promise<EnvOmniFi | null> {
  return executerPourWorkspaceSysteme(workspaceId)(async (tx) => {
    const r = await tx
      .select({ env: workspaces.omnifiEnvironment })
      .from(workspaces)
      .where(eq(workspaces.id, workspaceId))
      .limit(1);
    const env = r[0]?.env;
    return env === "sandbox" || env === "production" ? env : null;
  });
}

/** Écriture d'audit webhook, sous la primitive système (tygr_app + GUC tenant). */
export async function consignerAuditWebhook(
  workspaceId: string,
  evt: EvenementWebhookAConsigner,
): Promise<{ insere: boolean }> {
  return executerPourWorkspaceSysteme(workspaceId)((tx, ctx) =>
    consignerEvenementWebhook(tx, ctx, evt),
  );
}
