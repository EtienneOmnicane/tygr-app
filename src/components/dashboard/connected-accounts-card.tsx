/**
 * Carte « Comptes connectés » (side-panel du dashboard). Liste chaque compte
 * bancaire relié avec sa PROVENANCE (banque) + son libellé et son solde courant —
 * parité avec le benchmark FYGR. Présentationnel pur : reçoit les comptes résolus.
 *
 * Ordre dans la pile aside : SOLDE (SidePanelKpi) → DÉTAILS → COMPTES CONNECTÉS.
 *
 * Provenance des fonds (lisibilité) : on préfixe le compte du nom de l'institution
 * — « Absa · Compte courant » plutôt que « Compte courant » seul. CONTRACT-FIRST :
 * `CompteConnecte` n'expose pas ENCORE `institutionName` (l'API Omni-FI le fournit
 * — `OmniFiConnection.InstitutionName` — mais l'ingestion ne le persiste pas ; pas
 * de colonne `institution_name`, cf. TODOS « DASH-INST1 », frontière Backend). Tant
 * que le champ est absent, `libelleCompte` DÉGRADE proprement vers le seul
 * `accountName` — aucune mention « banque inconnue ». Le jour où le Backend ajoute
 * `institutionName` au contrat, la provenance s'affiche SANS retoucher ce composant.
 *
 * Montants : `formatMontant` (décomposition de chaîne, jamais de float — règle 8),
 * `tabular-nums` pour l'alignement des chiffres. `currentBalance` peut être null
 * (compte sans solde encore synchronisé) → tiret cadratin.
 */
import type { CompteConnecte } from "@/server/repositories/dashboard";

import { formatMontant } from "@/lib/format-montant";
import { StateCard } from "@/components/dashboard/states/primitives";

/**
 * Compte tel qu'AFFICHÉ par la carte. Étend `CompteConnecte` d'un `institutionName`
 * OPTIONNEL (contract-first) : le repository ne le fournit pas encore, mais l'UI est
 * prête à le consommer dès qu'il arrivera dans le contrat (zéro changement ici).
 */
type CompteAffiche = CompteConnecte & { institutionName?: string | null };

/**
 * Libellé « Banque · Compte » si la provenance est connue, sinon le seul nom de
 * compte. Dédoublonne le cas où `accountName` REPRENDRAIT déjà le nom de la banque
 * (ex. fixtures « MCB — Compte courant ») pour ne pas afficher « MCB · MCB — … ».
 */
function libelleCompte(compte: CompteAffiche): string {
  const banque = compte.institutionName?.trim();
  const nom = compte.accountName.trim();
  if (!banque) return nom;
  // Évite « Absa · Absa Courant » si le nom de compte commence déjà par la banque.
  if (nom.toLowerCase().startsWith(banque.toLowerCase())) return nom;
  return `${banque} · ${nom}`;
}

export function ConnectedAccountsCard({ comptes }: { comptes: CompteAffiche[] }) {
  // Aucun compte → la carte ne se monte pas (l'empty GLOBAL du dashboard a déjà
  // pris le relais en amont ; ici on évite une carte vide superflue).
  if (comptes.length === 0) return null;

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
      <ul className="mt-4 flex flex-col divide-y divide-line">
        {comptes.map((compte) => (
          <li
            key={compte.bankAccountId}
            className="flex flex-col gap-0.5 py-3 first:pt-0 last:pb-0"
          >
            <span className="truncate text-[13px] text-text" title={libelleCompte(compte)}>
              {libelleCompte(compte)}
            </span>
            <span className="text-sm font-semibold tabular-nums text-text">
              {compte.currentBalance
                ? formatMontant(compte.currentBalance, compte.currency)
                : "—"}
            </span>
          </li>
        ))}
      </ul>
    </StateCard>
  );
}
