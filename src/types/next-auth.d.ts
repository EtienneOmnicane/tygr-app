/**
 * Augmentation des types Auth.js — le JWT et la Session transportent le strict
 * nécessaire au pont vers withWorkspace : { userId, activeWorkspaceId, viewFilter }.
 * Le RÔLE n'est volontairement PAS dans le JWT : il est re-résolu à chaque
 * requête par withWorkspace (E14) — un rôle en JWT serait un cache périmable.
 *
 * `viewFilter` (L8b-1) = INTENTION d'affichage du sélecteur de périmètre : liste
 * d'UUID de comptes (`bank_account_id`). C'est du CONFORT, jamais une autorité —
 * le serveur l'intersecte avec le DROIT (account_scope) avant de poser le GUC, si
 * bien qu'il ne peut que RÉTRÉCIR la vue (cf. tenancy.ts:35-48, 391-419).
 * Convention « Groupe » : champ absent / null / [] ⇒ aucun filtre (on voit tout
 * le DROIT). On normalise [] → undefined à l'écriture du token (cf. config.ts).
 */
import type { DefaultSession } from "next-auth";

declare module "next-auth" {
  interface Session {
    userId?: string;
    activeWorkspaceId?: string | null;
    viewFilter?: string[] | null;
    /**
     * `pwdAt` (AUTH-MDP-TEMPO1 D4) = epoch ms du dernier POSAGE de mot de passe
     * au moment de l'émission du token (users.password_changed_at ; null =
     * jamais posé depuis la migration 0022). Comparé par ÉGALITÉ STRICTE à la
     * base à chaque requête gardée : un posage ultérieur invalide la session.
     */
    pwdAt?: number | null;
    user: DefaultSession["user"];
  }

  /** authorize() retourne le claim (config.ts) — recopié par le callback jwt. */
  interface User {
    pwdAt?: number | null;
  }
}

// NB : `next-auth/jwt` ré-exporte (`export *`) depuis @auth/core/jwt — une
// augmentation doit cibler le module qui DÉCLARE l'interface, pas le ré-export.
declare module "@auth/core/jwt" {
  interface JWT {
    userId?: string;
    activeWorkspaceId?: string | null;
    viewFilter?: string[] | null;
    pwdAt?: number | null;
  }
}
