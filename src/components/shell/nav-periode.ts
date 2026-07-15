/**
 * Helpers PURS de navigation liés à la PÉRIODE (TX/DASH-PERIODE-PERSIST1). Extraits des
 * composants pour être testables SANS renderer React (le projet n'en a pas — CLAUDE.md
 * § widget) : `sidebar-nav.tsx` et `reinitialiser-periode.tsx` ne sont que des coquilles de
 * câblage autour d'eux. Toute la décision (quoi propager, où, comment purger) vit ici.
 *
 * PROBLÈME RÉSOLU : la période vit dans l'URL (source unique — décision produit, PAS de
 * cookie/JWT), mais les liens de la sidebar étaient nus → un clic de nav la perdait, alors
 * que le périmètre (JWT, ambiant) survivait. Cette asymétrie est le bug. On PROPAGE donc la
 * période — mais SEULEMENT les 3 clés `CLES_PERIODE` (whitelist stricte : jamais les params
 * propres à une page comme `?q`/`?statut` de /transactions, qui pollueraient le Dashboard) et
 * SEULEMENT vers les segments qui la LISENT réellement.
 *
 * Aucun React, aucun état : `string`/`URLSearchParams` en entrée, `string` en sortie. La
 * matrice « qui lit la période » est RÉUTILISÉE depuis `toolbarConfig` (source unique, gardée
 * en CI par `toolbar-config.test.ts`) — pas une 2ᵉ liste de segments à maintenir en parallèle.
 */
import { toolbarConfig } from "@/components/shell/toolbar-config";
import { CLES_PERIODE } from "@/lib/periode";

/**
 * Extrait de `sp` la query ne portant QUE les clés de période (whitelist `CLES_PERIODE`), en
 * PRÉSERVANT un param dupliqué (`getAll`/`append`, jamais `.get()` qui perdrait la 2ᵉ valeur) :
 * le serveur de la page cible rejette le doublon EXACTEMENT comme le fait la page source
 * (`paramsPeriodeDepuisURL`) → les deux côtés voient la même chose et replient pareil. Ne
 * touche JAMAIS les autres params. Retourne "" si aucune clé de période n'est présente.
 */
export function queryPeriodeDepuis(sp: URLSearchParams): string {
  const query = new URLSearchParams();
  for (const cle of CLES_PERIODE) {
    for (const valeur of sp.getAll(cle)) query.append(cle, valeur);
  }
  return query.toString();
}

/**
 * Le segment de `hrefCible` LIT-il la période ? On réutilise la matrice `toolbarConfig`
 * (source unique, gardée en CI) : `periode` OU `plageDates` vrai (Dashboard "", /transactions).
 * → on ne colle JAMAIS un `?periode` fantôme sur /banques, /regles, /echeances, /graphiques
 * (pages qui l'ignorent — un param mort dans l'URL serait un mensonge d'affichage à l'échelle
 * de l'URL, exactement la classe de bug que la matrice A1/A2 combat).
 */
export function doitPropagerPeriode(hrefCible: string): boolean {
  const config = toolbarConfig(hrefCible);
  return config.periode || config.plageDates;
}

/**
 * href du `<Link>` : `hrefCible` + la query de période SSI (le segment la lit ET il y a une
 * période à propager), sinon `hrefCible` NU. ⚠️ NE PAS confondre avec l'href servant à l'état
 * actif de la nav : celui-là doit rester NU (cf. `estActifNav`) — d'où deux fonctions séparées.
 */
export function hrefAvecPeriode(hrefCible: string, sp: URLSearchParams): string {
  if (!doitPropagerPeriode(hrefCible)) return hrefCible;
  const query = queryPeriodeDepuis(sp);
  return query ? `${hrefCible}?${query}` : hrefCible;
}

/**
 * Un item de nav est-il ACTIF pour le `pathname` courant ? Règle inchangée de `sidebar-nav`
 * (le Dashboard "/" est exact — sinon `startsWith("/")` allumerait TOUT ; les autres en préfixe
 * pour couvrir les sous-routes, ex. /transactions/tx-123).
 *
 * ⚠️ Prend l'href NU + le `pathname` réel (`usePathname` ne rend NI query NI hash) → l'état
 * actif est INDÉPENDANT des params propagés. Calculer l'actif sur l'href porteur de query
 * (`/transactions?periode=3m`) ferait échouer le `startsWith` et démarquerait la page active —
 * c'est le piège explicite du ticket, rendu impossible en séparant ce calcul de `hrefAvecPeriode`.
 */
export function estActifNav(hrefItem: string, pathname: string): boolean {
  return hrefItem === "/" ? pathname === "/" : pathname.startsWith(hrefItem);
}

/**
 * Query de `sp` PRIVÉE des 3 clés de période (les AUTRES params PRÉSERVÉS) — pour le reset :
 * `router.replace(pathname + "?" + retirerPeriodeQuery(sp))` ramène le groupe période au
 * défaut « 6 mois » sans toucher au reste (ex. la recherche `?q` de /transactions survit).
 * Retourne "" si seules des clés de période étaient présentes → URL propre (`pathname` nu).
 */
export function retirerPeriodeQuery(sp: URLSearchParams): string {
  const query = new URLSearchParams(sp.toString());
  for (const cle of CLES_PERIODE) query.delete(cle);
  return query.toString();
}
