/**
 * Décide si le montant affiché au CENTRE du donut doit être RÉSUMÉ (format compact) ou
 * peut s'écrire en entier.
 *
 * ## Pourquoi un module à part, et pas trois lignes dans le composant
 * La bascule est une fonction PURE de deux helpers de `format-montant.ts`, et c'est la
 * seule chose ici qui puisse se tromper en silence : un seuil décalé d'un rang rend soit
 * un montant qui déborde de l'anneau, soit un montant résumé alors qu'il tenait — deux
 * défauts qu'aucun `lint`/`tsc`/test de rendu n'attrape (le projet n'a pas de renderer
 * React). Sortie du `.tsx`, elle est couverte par `tests/unit/format-centre.test.ts`,
 * qui échoue si l'un des seuils bouge. C'est la même convention que
 * `pourcent-part.ts` / `flux-etiquettes.ts` : la décision est testée, le JSX ne fait que
 * l'appliquer.
 *
 * ## Les seuils sont MESURÉS, pas estimés
 * Protocole et relevés : `docs/qa/donut-total-central/README.md`. Montants pleins de 6 à
 * 14 chiffres injectés dans le span réel du centre, à 1440 px, comparés à la CORDE du
 * cercle intérieur (135,3 px) — pas à son diamètre : une ligne décalée du centre ne
 * dispose que d'une corde.
 *
 * On raisonne en NOMBRE DE CHIFFRES et jamais en valeur : comparer un montant à 10^8
 * supposerait de le convertir en `number`, donc de perdre des centimes (règle 8).
 */
import { chiffresPartieEntiere, symbolePrefixe } from "@/lib/format-montant";

/**
 * Devise à symbole en PRÉFIXE (`Rs`/`$`/`€`) : le plein tient jusqu'à 8 chiffres.
 *
 * ⚠️ Calibré sur le PIRE préfixe, `Rs` (128,6 px à 8 chiffres, 138,2 px à 9 — la corde
 * fait 135,3). `$` et `€` sont plus étroits et tiendraient encore à 9 chiffres (129,3 et
 * 132,5 px) : à ce rang ils sont donc résumés alors qu'ils pourraient s'écrire. C'est un
 * choix ASSUMÉ, pas un oubli — un seuil par devise ferait dépendre l'affichage d'une
 * marge de 2,8 px sur l'euro, que le moindre ajustement de police ou de graisse
 * invaliderait sans bruit. Un seuil par GABARIT reste vrai tant que le gabarit ne change
 * pas. Le coût est borné : il ne concerne que des totaux USD/EUR ≥ 100 000 000.
 */
export const SEUIL_CHIFFRES_PREFIXE = 9;

/**
 * Devise inconnue → repli code ISO en SUFFIXE (« … GBP ») : ~16 px de plus que le
 * symbole en préfixe, donc le plein ne tient déjà plus à 8 chiffres (144,6 px).
 *
 * Conséquence à connaître : pour toute devise hors `MUR`/`USD`/`EUR`, la bascule tombe
 * dès 10 000 000 — un montant ordinaire, pas un cas extrême.
 */
export const SEUIL_CHIFFRES_SUFFIXE = 8;

/**
 * Vrai si le montant doit être résumé au centre de l'anneau.
 *
 * @param montant chaîne décimale (la valeur SQL, jamais un `number`)
 * @param devise code ISO — décide du GABARIT (symbole en préfixe vs code en suffixe),
 *   pas de la valeur. Une devise vide (« montant nu ») est le gabarit le plus étroit de
 *   tous ; elle retombe sur le seuil suffixe, donc elle résume plus tôt que nécessaire.
 *   Volontairement non optimisé : `bank_accounts.currency` est `char(3) NOT NULL`, donc
 *   ce cas n'atteint pas cet écran — le traiter à part ajouterait une branche que rien
 *   n'exercerait.
 */
export function doitResumerAuCentre(montant: string, devise: string): boolean {
  const seuil = symbolePrefixe(devise)
    ? SEUIL_CHIFFRES_PREFIXE
    : SEUIL_CHIFFRES_SUFFIXE;
  return chiffresPartieEntiere(montant) >= seuil;
}
