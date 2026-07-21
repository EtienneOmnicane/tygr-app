/**
 * Mention de RÉTROACTIVITÉ sous les donuts (décision D-g, arbitrage Q2 = b).
 *
 * POURQUOI CET ÉCRAN EN A BESOIN. Le donut lit l'état PERSISTÉ des ventilations : il
 * n'évalue AUCUNE règle à la lecture (ce serait coûteux, non déterministe vis-à-vis de
 * /transactions, et ça divergerait de l'audit `categorization_audit`). Conséquence
 * invisible pour l'utilisateur : une règle créée aujourd'hui ne change RIEN aux mois
 * passés tant que « Ré-analyser » n'a pas tourné, ou qu'un nouveau sync n'a pas touché
 * le compte. Il crée « Loyer », revient ici, ne voit rien bouger, et conclut que la
 * fonctionnalité est cassée — c'est exactement le ticket qui a produit ce chantier.
 * Le comportement silencieux est donc écarté ; la mention explique et donne la sortie.
 *
 * SANS COMPTEUR DE DÉSYNCHRONISATION (variante Q2 = c, explicitement hors périmètre) :
 * afficher « N transactions non ré-analysées » supposerait d'évaluer les règles non
 * appliquées à chaque affichage — une requête de plus, sur le chemin d'un écran de
 * lecture, pour une information que le bouton rend de toute façon.
 *
 * Le lien pointe la page Règles (qui porte le bouton « Ré-analyser les transactions »,
 * réservé MANAGER/ADMIN) — il ne DÉCLENCHE rien lui-même : une action d'écriture ne se
 * lance pas depuis un écran d'analyse, et l'habilitation se vérifie là-bas.
 *
 * Présentationnel pur : aucun fetch, aucun état, aucune Server Action.
 */
import Link from "next/link";

export function MentionReanalyse() {
  return (
    <p className="text-xs leading-relaxed text-text-muted">
      Les catégories affichées reflètent vos règles telles qu’elles ont déjà été
      appliquées. Une règle créée récemment ne s’applique pas rétroactivement —{" "}
      <Link
        href="/regles"
        className="rounded-control font-medium text-primary underline underline-offset-2 hover:no-underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
      >
        ré-analyser vos transactions
      </Link>{" "}
      pour la rejouer sur l’historique.
    </p>
  );
}
