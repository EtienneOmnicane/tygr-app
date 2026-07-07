/**
 * Carte « Comptes connectés » (side-panel du dashboard). Liste chaque compte
 * bancaire relié avec sa PROVENANCE (banque) + son libellé et son solde courant —
 * parité avec le benchmark FYGR. Présentationnel pur : reçoit les comptes résolus.
 *
 * Emplacement (refonte Dodo) : colonne droite du dashboard (1fr), empilée SOUS la
 * carte « Synthèse du mois », à droite de la courbe de flux — comble l'espace résiduel.
 *
 * GROUPEMENT PAR TITULAIRE (PLAN-bandeau-titulaire-accordeon.md, D4/D7) : les
 * comptes sont regroupés par party Omni-FI (`grouperParTitulaire`) en accordéon
 * natif `<details>/<summary>` — zéro dépendance, zéro "use client", le composant
 * reste server-render. DISPLAY-ONLY (règle 2) : le titulaire est un libellé,
 * jamais un filtre ; chaque compte visible reste rendu (replié ≠ masqué).
 *  - `summary` = nom du titulaire (tronqué) + compteur « N comptes » ; PAS de
 *    solde agrégé par groupe en v1 (D5 — piège cross-devise/float, règle 8).
 *  - Tous les volets REPLIÉS par défaut (l'objectif : nettoyer le scroll).
 *  - Bucket « Non regroupé » (comptes sans party exploitable) toujours en dernier.
 *  - REPLI mono-groupe : < 2 groupes → liste plate historique (pas d'accordéon
 *    superflu à un seul volet).
 *
 * Provenance des fonds (DR-F2, refonte 2 lignes 2026-06-22, Lot 4) : la banque et le
 * nom de compte vivent sur DEUX lignes distinctes (banque en label `text-muted` 11px
 * AU-DESSUS, nom de compte 13px DESSOUS), chacune tronquée INDÉPENDAMMENT. Avant, les
 * deux étaient fusionnés (« Banque · Compte ») sur une seule ligne `truncate` ~300px :
 * un nom de banque long (« The Mauritius Commercial Bank ») mangeait le nom de compte.
 * Le montant n'est JAMAIS tronqué (chiffre clé, règle de formatage figée 2026-06-22).
 *
 * `institutionName` fait partie du contrat `CompteConnecte` (string | null, résolu via
 * la connexion). Quand il est absent, la ligne banque est simplement OMISE (dégradation
 * propre : aucune mention « banque inconnue », le compte s'affiche seul).
 *
 * Montants : `formatMontant` (décomposition de chaîne, jamais de float — règle 8),
 * `tabular-nums` pour l'alignement des chiffres. `currentBalance` peut être null
 * (compte sans solde encore synchronisé) → tiret cadratin.
 */
import type { CompteConnecte } from "@/server/repositories/dashboard";

import { formatMontant } from "@/lib/format-montant";
import { grouperParTitulaire } from "@/lib/grouper-titulaire";
import { StateCard } from "@/components/dashboard/states/primitives";

/**
 * Provenance affichée d'un compte : la banque en LABEL (ligne du dessus) et le nom de
 * compte (ligne du dessous), résolus depuis `CompteConnecte`.
 *
 * - Banque connue + nom de compte distinct → banque en label, compte dessous.
 * - Banque connue mais le nom de compte REPREND déjà la banque (ex. fixtures
 *   « MCB — Compte courant ») → on n'affiche PAS le label banque (il ferait doublon) ;
 *   le nom de compte porte déjà la provenance.
 * - Banque absente → pas de label, nom de compte seul.
 */
function provenance(compte: CompteConnecte): {
  banque: string | null;
  nomCompte: string;
} {
  const banque = compte.institutionName?.trim();
  const nomCompte = compte.accountName.trim();
  if (!banque) return { banque: null, nomCompte };
  // Le nom de compte commence déjà par la banque → le label ferait doublon.
  if (nomCompte.toLowerCase().startsWith(banque.toLowerCase())) {
    return { banque: null, nomCompte };
  }
  return { banque, nomCompte };
}

/** Ligne compte (markup historique, réutilisé tel quel en liste plate ET en groupe). */
function LigneCompte({ compte }: { compte: CompteConnecte }) {
  const { banque, nomCompte } = provenance(compte);
  return (
    <li className="flex items-start justify-between gap-3 py-3 first:pt-0 last:pb-0">
      {/* Identité du compte sur 2 lignes — `min-w-0` autorise le `truncate`
          des enfants à l'intérieur d'un flex (sinon le flex item refuse de
          rétrécir et le texte déborderait au lieu de tronquer). */}
      <div className="flex min-w-0 flex-col gap-0.5">
        {banque && (
          <span
            className="truncate text-[11px] font-medium uppercase tracking-[0.04em] text-text-muted"
            title={banque}
          >
            {banque}
          </span>
        )}
        <span className="truncate text-[13px] text-text" title={nomCompte}>
          {nomCompte}
        </span>
      </div>
      {/* Solde — jamais tronqué (chiffre clé) : `whitespace-nowrap`,
          `tabular-nums`, et `shrink-0` pour qu'il garde toujours sa place. */}
      <span className="shrink-0 whitespace-nowrap text-sm font-semibold tabular-nums text-text">
        {compte.currentBalance
          ? formatMontant(compte.currentBalance, compte.currency)
          : "—"}
      </span>
    </li>
  );
}

export function ConnectedAccountsCard({ comptes }: { comptes: CompteConnecte[] }) {
  // Aucun compte → la carte ne se monte pas (l'empty GLOBAL du dashboard a déjà
  // pris le relais en amont ; ici on évite une carte vide superflue).
  if (comptes.length === 0) return null;

  const groupes = grouperParTitulaire(comptes);

  return (
    <StateCard>
      <div className="flex items-center justify-between">
        <span className="text-[11px] font-semibold uppercase tracking-[0.08em] text-text-muted">
          Comptes connectés
        </span>
        <span className="text-xs font-medium tabular-nums text-text-muted">
          {comptes.length}
        </span>
      </div>

      {groupes.length < 2 ? (
        /* Repli mono-groupe (un seul titulaire, ou tous « Non regroupé ») :
           liste plate historique — un accordéon à un volet n'apporte rien. */
        <ul className="mt-4 flex flex-col divide-y divide-line">
          {comptes.map((compte) => (
            <LigneCompte key={compte.bankAccountId} compte={compte} />
          ))}
        </ul>
      ) : (
        <div className="mt-4 flex flex-col divide-y divide-line">
          {groupes.map((groupe) => {
            const nb = groupe.comptes.length;
            // D7 : jamais un « null » brut — bucket sobre, toujours en dernier
            // (garanti par grouperParTitulaire).
            const titre = groupe.holderName ?? "Non regroupé";
            return (
              <details
                key={groupe.holderId ?? "non-regroupe"}
                className="group py-3 first:pt-0 last:pb-0"
              >
                <summary
                  className="flex cursor-pointer list-none items-center justify-between gap-3
                    rounded-control focus:outline-none focus-visible:ring-2
                    focus-visible:ring-primary [&::-webkit-details-marker]:hidden"
                >
                  <span className="flex min-w-0 items-center gap-2">
                    <span
                      aria-hidden
                      className="shrink-0 text-[10px] text-text-muted transition-transform
                        group-open:rotate-90"
                    >
                      ▸
                    </span>
                    <span
                      className={
                        groupe.holderId === null
                          ? "truncate text-[13px] font-medium text-text-muted"
                          : "truncate text-[13px] font-medium text-text"
                      }
                      title={titre}
                    >
                      {titre}
                    </span>
                  </span>
                  {/* Compteur d'orientation (D5) : « N comptes », PAS un solde
                      agrégé (jamais d'addition cross-devise, règle 8). */}
                  <span className="shrink-0 whitespace-nowrap text-xs tabular-nums text-text-muted">
                    {nb} compte{nb > 1 ? "s" : ""}
                  </span>
                </summary>
                <ul className="mt-1 flex flex-col divide-y divide-line/60 pl-4">
                  {groupe.comptes.map((compte) => (
                    <LigneCompte key={compte.bankAccountId} compte={compte} />
                  ))}
                </ul>
              </details>
            );
          })}
        </div>
      )}
    </StateCard>
  );
}
