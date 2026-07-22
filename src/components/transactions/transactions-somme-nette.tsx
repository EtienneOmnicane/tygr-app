/**
 * Bandeau « Total des résultats filtrés » de /transactions (TX-RECHERCHE-SOMME-NETTE1).
 * Monté par le conteneur UNIQUEMENT quand un filtre est actif (recherche / statut /
 * bornes de date) : sans filtre, un total sur toute l'histoire du workspace n'aurait
 * aucun sens ici (c'est le rôle du dashboard).
 *
 * Présentationnel PUR : reçoit des totaux DÉJÀ agrégés par le serveur
 * (`sommeNetteParDevise`, SUM en SQL sous RLS). Zéro fetch, zéro état, et surtout ZÉRO
 * CALCUL — l'UI ne somme jamais des montants :
 *  - la pagination est en KEYSET → le client ne détient qu'UNE page ; additionner les
 *    lignes affichées ne totaliserait que le visible, pas le jeu filtré (piège TX-FILTRE1) ;
 *  - un montant ne se recalcule pas en JS (règle 8 : jamais de float sur de l'argent).
 * Les chaînes décimales arrivent prêtes ; on ne fait que les METTRE EN FORME via la
 * source unique `@/lib/format-montant` (aucun formateur local, cf. dette C8).
 *
 * Multi-devises (règle 8) : UNE LIGNE PAR DEVISE, JAMAIS d'addition cross-devise, aucune
 * conversion FX. RIEN n'est tronqué ici : ni les montants (jamais un chiffre clé), ni le
 * nom de devise — « Roupie mauricienne » coupé en « Roupie mauricienn… » se lit comme un
 * bug, pas comme une abréviation. Sur un écran trop étroit pour les quatre colonnes,
 * c'est la table qui DÉFILE (conteneur `overflow-x-auto`) plutôt qu'un mot qui se casse.
 *
 * ALIGNEMENT DES VIRGULES (contrat `UI-SOLDE-MULTIDEVISE-POLISH1`, cf. `format-montant`) :
 * chaque montant est rendu en DEUX morceaux — l'indicateur de devise (`indicateurDevise`,
 * toujours à GAUCHE, symbole `Rs`/`$`/`€` ou code ISO en repli) puis le corps numérique NU
 * (`montantNu`, `tabular-nums`, aligné à droite). On n'emploie PAS `formatMontant` ici :
 * pour une devise hors table (ZAR, GBP…) il renvoie le code en SUFFIXE (« 1 200,00 ZAR »),
 * ce qui décalerait la virgule de CETTE ligne par rapport aux autres.
 *
 * Couleurs (UI_GUIDELINES §3.1-§3.3 — le vert/rouge EST l'information) : `entrees` en
 * `inflow-700`, `sorties` en `outflow-700` (ce sont des MAGNITUDES positives : le sens
 * vient du libellé et de la teinte), et le `net` coloré par SON SIGNE (négatif = sortie
 * nette, zéro = neutre). Variantes `-700` (et non les tokens par défaut) : ce sont celles
 * qu'emploient la table juste en dessous et les montants-texte de l'app — contraste AA
 * sur fond clair, et pas deux verts différents sur le même écran. Aucune couleur en dur.
 */
import {
  estNegatif,
  estZero,
  indicateurDevise,
  montantNu,
  nomDevise,
} from "@/lib/format-montant";
import { cn } from "@/components/ui/states";

import type { SommeNetteDevise } from "./types-transactions";

/** Teinte du NET selon son signe (§3.1) : positif = entrée, négatif = sortie, 0 = neutre. */
function classeNet(net: string): string {
  if (estZero(net)) return "text-text-muted";
  return estNegatif(net) ? "text-outflow-700" : "text-inflow-700";
}

/**
 * Un montant de cellule : indicateur de devise (largeur auto, à gauche) + corps numérique
 * nu. Ce découpage — et non `formatMontant` — est ce qui ALIGNE les virgules décimales
 * d'une devise à l'autre (cf. en-tête). `signeExplicite` n'est utilisé que pour le NET
 * (un `+` devant un net positif) ; un zéro n'a jamais de signe (garanti par le formateur).
 */
function Montant({
  valeur,
  devise,
  signeExplicite = false,
}: {
  valeur: string;
  devise: string;
  signeExplicite?: boolean;
}) {
  const indicateur = indicateurDevise(devise);
  return (
    <>
      {indicateur && (
        <span className="mr-1 font-normal text-text-faint">{indicateur}</span>
      )}
      {montantNu(valeur, { signeExplicite })}
    </>
  );
}

export function TransactionsSommeNette({
  totaux,
}: {
  /** Totaux par devise, déjà agrégés côté serveur. Vide → le bandeau ne s'affiche pas. */
  totaux: SommeNetteDevise[];
}) {
  // Aucune devise = aucun résultat filtré : la liste affiche déjà son état vide, un
  // bandeau « Rs 0,00 » serait un chiffre inutile (et trompeur : 0 dans QUELLE devise ?).
  if (totaux.length === 0) return null;

  return (
    <section
      aria-labelledby="somme-nette-titre"
      // Le total change SANS action de l'utilisateur sur ce bloc (il suit la recherche
      // débouncée) : `polite` l'annonce au lecteur d'écran une fois la frappe finie,
      // sans interrompre. Sans ça, un utilisateur non-voyant ne saurait jamais que le
      // total s'est rafraîchi.
      aria-live="polite"
      className="rounded-card border border-line bg-surface-inset px-4 py-3"
    >
      <h2
        id="somme-nette-titre"
        className="text-[11px] font-semibold uppercase tracking-[0.08em] text-text-muted"
      >
        Total des résultats filtrés
      </h2>

      {/* Un vrai <table> (et pas une grille de <div>) : données tabulaires à en-têtes de
          colonnes ET de ligne → association valeur↔en-tête gratuite pour le lecteur
          d'écran, et alignement des colonnes (donc des virgules) garanti par le moteur de
          rendu, sans largeur en dur. */}
      {/* Sous ~400 px, quatre colonnes dont trois de montants INSÉCABLES ne tiennent pas :
          la table défile alors DANS ce conteneur (la page, elle, ne défile jamais). C'est
          le moindre mal — l'alternative serait de raboter un chiffre.
          `role=region` + `tabIndex=0` : une zone défilante doit être atteignable au
          CLAVIER, sinon le Net devient inaccessible sans souris dès qu'elle défile.
          `aria-label` PROPRE (et non un `aria-labelledby` vers le titre de la section) :
          la section porte déjà ce titre, le réutiliser ferait annoncer deux fois le même
          nom pour deux niveaux imbriqués. Inerte tant qu'il n'y a rien à faire défiler. */}
      <div
        role="region"
        aria-label="Totaux par devise"
        tabIndex={0}
        className="mt-2 overflow-x-auto focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
      >
        <table className="w-full text-xs">
          <thead>
            <tr className="text-[11px] uppercase tracking-wide text-text-faint">
              <th scope="col" className="text-left font-medium">
                Devise
              </th>
              <th scope="col" className="px-3 text-right font-medium">
                Entrées
              </th>
              <th scope="col" className="px-3 text-right font-medium">
                Sorties
              </th>
              <th scope="col" className="pl-3 text-right font-medium">
                Net
              </th>
            </tr>
          </thead>
          <tbody>
            {totaux.map((t) => (
              <tr key={t.devise}>
                {/* Cellule ÉLASTIQUE, et c'est voulu. Elle portait `max-w-0 truncate` —
                  le hack qui écrase une cellule de table au minimum pour forcer la
                  coupe : sur une table de 942 px il ne laissait que 105 px au libellé et
                  hachait « Roupie mauricienne » EN PLEIN MOT alors que la place était là.
                  Ce qui est proscrit, c'est le mot haché, pas le retour à la ligne : sans
                  contrainte, le repli CSS tombe entre « Roupie » et « mauricienne » et les
                  deux mots restent entiers.
                  Surtout, ne PAS mettre `whitespace-nowrap` ici : mesuré, la colonne
                  devenait alors incompressible et poussait le NET — le chiffre clé —
                  hors de l'écran sous 640 px. Les seuls éléments rigides de la ligne
                  doivent être les montants. Un libellé cède, jamais un chiffre
                  (CLAUDE.md, formatage des données financières). */}
                <th
                  scope="row"
                  className="py-0.5 pr-3 text-left font-normal text-text-muted"
                >
                  {nomDevise(t.devise)}
                  <span className="text-text-faint">
                    {" · "}
                    {t.nbTransactions} opération
                    {t.nbTransactions > 1 ? "s" : ""}
                  </span>
                </th>
                <td className="whitespace-nowrap px-3 py-0.5 text-right font-medium tabular-nums text-inflow-700">
                  <Montant valeur={t.entrees} devise={t.devise} />
                </td>
                <td className="whitespace-nowrap px-3 py-0.5 text-right font-medium tabular-nums text-outflow-700">
                  <Montant valeur={t.sorties} devise={t.devise} />
                </td>
                {/* Le NET est le chiffre clé du bandeau : plus gros, plus gras, coloré par
                  son signe. */}
                <td
                  className={cn(
                    "whitespace-nowrap py-0.5 pl-3 text-right text-sm font-semibold tabular-nums",
                    classeNet(t.net),
                  )}
                >
                  <Montant valeur={t.net} devise={t.devise} signeExplicite />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Honnêteté multi-devises : on n'additionne JAMAIS des roupies et des dollars, et
          on n'invente aucun taux de change (chantier DASH-FX1). On le DIT plutôt que de
          laisser croire à un total manquant. */}
      {totaux.length > 1 && (
        <p className="mt-2 text-[11px] text-text-faint">
          Chaque devise est totalisée séparément — jamais d’addition entre
          devises.
        </p>
      )}
    </section>
  );
}
