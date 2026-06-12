/**
 * Endpoints Auth.js (login/logout/session/csrf) — handlers générés, protection
 * CSRF intégrée au framework. La logique métier vit dans src/auth.ts et
 * src/lib/auth/ ; rien d'autre ne doit apparaître ici.
 */
import { handlers } from "@/server/auth/config";

export const { GET, POST } = handlers;
