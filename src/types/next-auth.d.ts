/**
 * Augmentation des types Auth.js — le JWT et la Session transportent le strict
 * nécessaire au pont vers withWorkspace : { userId, activeWorkspaceId }.
 * Le RÔLE n'est volontairement PAS dans le JWT : il est re-résolu à chaque
 * requête par withWorkspace (E14) — un rôle en JWT serait un cache périmable.
 */
import type { DefaultSession } from "next-auth";

declare module "next-auth" {
  interface Session {
    userId?: string;
    activeWorkspaceId?: string | null;
    user: DefaultSession["user"];
  }
}

// NB : `next-auth/jwt` ré-exporte (`export *`) depuis @auth/core/jwt — une
// augmentation doit cibler le module qui DÉCLARE l'interface, pas le ré-export.
declare module "@auth/core/jwt" {
  interface JWT {
    userId?: string;
    activeWorkspaceId?: string | null;
  }
}
