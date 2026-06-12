/**
 * Permissions par rôle (Epic 2 / gating VIEWER, plan D2 ligne 37) — PUR,
 * isomorphe (client + serveur), zéro I/O. La frontière d'autorité réelle reste
 * côté serveur (le rôle vient de withWorkspace, re-résolu à chaque requête) ;
 * ces helpers ne font que TRADUIRE un rôle déjà résolu en capacités UI.
 *
 * Convention unique des rôles (plan D2 #37) : VIEWER = lecture seule (actions de
 * modification DÉSACTIVÉES + tooltip) ; surfaces ADMIN CACHÉES si non-ADMIN
 * (absentes du DOM, pas juste grisées).
 */
import type { WorkspaceRole } from "@/server/db/schema";

/** VIEWER ne peut pas modifier (saisie, banques, override). MANAGER/ADMIN oui. */
export function peutModifier(role: WorkspaceRole): boolean {
  return role !== "VIEWER";
}

/** Les surfaces d'administration (membres, sync_runs) sont réservées à l'ADMIN. */
export function peutAdministrer(role: WorkspaceRole): boolean {
  return role === "ADMIN";
}
