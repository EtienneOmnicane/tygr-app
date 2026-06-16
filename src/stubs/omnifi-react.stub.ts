/**
 * Stub de BUILD pour le package privé `@omnifi/react` (module fantôme).
 *
 * ⚠️ Ce fichier n'est PAS du code produit — c'est un artefact de build.
 *
 * Pourquoi il existe : `@omnifi/react` vit sur un registre npm PRIVÉ (poste de
 * démo uniquement) et est absent de `node_modules` en local/CI. Le hotfix
 * lazy-load (`next/dynamic` dans `bank-connect-widget.tsx`) retarde l'EXÉCUTION
 * du hook, mais `next build` résout TOUT le graphe d'imports STATIQUEMENT : il
 * « voit » `import { useOmniFILink } from "@omnifi/react"` dans
 * `omnifi-link-launcher.tsx`, ne trouve pas le fichier sur disque → `Module not
 * found`, build cassé.
 *
 * Parade : `next.config.ts` détecte l'absence du vrai package (`require.resolve`)
 * et, dans ce cas SEULEMENT, alias `@omnifi/react` → ce stub (Turbopack +
 * Webpack). Le graphe statique est satisfait, le build passe. Sur le poste de
 * démo (vrai package présent), l'alias est désactivé → le vrai module est utilisé.
 *
 * Le `.d.ts` (`src/types/omnifi-react.d.ts`) fournit les TYPES à `tsc` ; ce stub
 * fournit l'IMPLÉMENTATION JS absente que le bundler exige. Surface répliquée :
 * uniquement `useOmniFILink` (seul import de VALEUR ; `OmniFiSuccessPayload` est
 * un `import type`, effacé à la compilation, donc inutile ici).
 *
 * Comportement : `throw`. Ce stub ne doit JAMAIS s'exécuter — le launcher n'est
 * monté que sur action utilisateur et le `WidgetErrorBoundary` parent capture
 * toute erreur. Si malgré tout il est appelé (package réellement absent au
 * runtime), on lève proprement → UI « module indisponible » du garde-fou, jamais
 * un crash silencieux ni une fausse connexion bancaire.
 */
import type { UseOmniFiLinkResult } from "@omnifi/react";

// Signature volontairement sans paramètre : le stub `throw` avant tout usage, et
// le `.d.ts` (`src/types/omnifi-react.d.ts`) reste la source de vérité du contrat
// d'appel pour `tsc`. On ne déclare donc pas de `config` inutilisé (eslint vierge).
export function useOmniFILink(): UseOmniFiLinkResult {
  throw new Error(
    "@omnifi/react est absent (stub de build). Installez le vrai package depuis le " +
      "registre privé Omni-FI sur l'environnement de démonstration pour activer la " +
      "connexion bancaire native.",
  );
}
