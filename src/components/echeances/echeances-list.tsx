"use client";

/**
 * Liste DIRIGÉE des échéances (une seule direction à la fois : « à encaisser » OU
 * « à décaisser » — la vue est choisie par le conteneur). Présentationnel : reçoit
 * un sous-ensemble DÉJÀ filtré + trié (le serveur trie par exigibilité croissante,
 * donc les « en retard » remontent en tête) + un dictionnaire id→nom de catégorie +
 * des handlers. Ne fetch rien, ne connaît pas le workspace.
 *
 * Colonnes (cadrage §3.1.2) : libellé, contrepartie, date d'exigibilité, montant
 * (coloré par le SENS — inflow/outflow §3.1, `tabular-nums`, JAMAIS tronqué),
 * catégorie (badge), statut (badge §3.6). Actions inline : changer le statut,
 * modifier, supprimer.
 *
 * Gating VIEWER (convention D2 #37, `peutGerer=false`) :
 * - « Modifier » / « Supprimer » = actions de MODIFICATION → restent VISIBLES mais
 *   INERTES (`BoutonProtege` : aria-disabled + tooltip explicatif, focusable). On ne
 *   les cache pas : le VIEWER doit savoir que la capacité existe.
 * - Le CONTRÔLE de statut (`StatutControl`) n'a pas de forme inerte lisible (c'est un
 *   sélecteur) : en lecture seule il est remplacé par le badge d'état correspondant,
 *   qui porte la même information sans suggérer une interaction.
 *
 * Montants (règle 8) : formatage EXCLUSIF via `format-montant` (aucun découpage local).
 * Dates : via `format-date` (aucun nom de mois en dur). Le restant d'un « partiel »
 * est affiché en sous-libellé (montant plein − part réglée), toujours formaté.
 */
import { useEffect, useState } from "react";

import { BoutonProtege } from "@/components/ui/action-protegee";
import { CategoryBadge } from "@/components/ui/category";
import { Select } from "@/components/ui/select";
import { formaterDateComptableLongue } from "@/lib/format-date";
import { formatMontant, montantNu } from "@/lib/format-montant";

/** Tooltip du gating VIEWER : dit POURQUOI, pas seulement « interdit ». */
const RAISON_ECHEANCES =
  "Votre rôle (lecture seule) ne permet pas de gérer les échéances.";

import { EcheanceBadge, libelleStatut } from "./echeance-badge";
import type {
  ChangerStatutInputUI,
  EcheanceUI,
  StatutEcheance,
} from "./types-echeances";

/** Concatène des classes en ignorant les valeurs falsy. Pas de clsx (règle 9). */
function cn(...classes: Array<string | false | null | undefined>): string {
  return classes.filter(Boolean).join(" ");
}

/** Statuts STOCKÉS transitionnables (jamais « en_retard », qui est dérivé). */
const STATUTS_CHOIX: StatutEcheance[] = [
  "en_cours",
  "partiel",
  "paiement_en_cours",
  "payee",
  "annulee",
];

/** Restant dû (chaîne décimale) = montant − part réglée. Soustraction ENTIÈRE en
 * centimes (jamais de float, règle 8) — les deux chaînes sont des numeric(15,2). */
function restantDecimal(montant: string, montantRegle: string): string {
  const enCentimes = (s: string): bigint => {
    const [ent, dec = ""] = s.trim().replace(",", ".").split(".");
    const dec2 = (dec + "00").slice(0, 2);
    return BigInt(ent + dec2);
  };
  const diff = enCentimes(montant) - enCentimes(montantRegle);
  const neg = diff < BigInt(0);
  const abs = (neg ? -diff : diff).toString().padStart(3, "0");
  const ent = abs.slice(0, -2);
  const dec = abs.slice(-2);
  return `${neg ? "-" : ""}${ent}.${dec}`;
}

/**
 * Contrôle inline de changement de statut. Local UI state UNIQUEMENT (pas de fetch) :
 * un select des statuts + un champ « part réglée » révélé quand on choisit « partiel »
 * (le contrat exige alors un montant réglé). Confirme via `onChanger`.
 */
function StatutControl({
  echeance,
  enCours,
  onChanger,
}: {
  echeance: EcheanceUI;
  enCours: boolean;
  onChanger: (input: ChangerStatutInputUI) => void;
}) {
  const [saisiePartiel, setSaisiePartiel] = useState<string | null>(null);
  const [montantRegle, setMontantRegle] = useState(echeance.montantRegle ?? "");

  const champPetit =
    "h-8 rounded-control border border-line bg-surface-card px-2 text-xs text-text " +
    "focus:border-primary focus:outline-none focus-visible:ring-2 focus-visible:ring-primary " +
    "disabled:opacity-[0.48]";

  function auChangement(valeur: StatutEcheance) {
    if (valeur === echeance.statut && valeur !== "partiel") return;
    if (valeur === "partiel") {
      setSaisiePartiel("partiel"); // révèle le champ de part réglée
      return;
    }
    setSaisiePartiel(null);
    onChanger({ echeanceId: echeance.id, statut: valeur });
  }

  const partielValide = /^\d{1,13}([.,]\d{1,2})?$/.test(montantRegle.trim());

  return (
    <div className="flex flex-col items-end gap-1">
      <Select
        ariaLabel="Changer le statut"
        size="sm"
        value={echeance.statut}
        disabled={enCours}
        onChange={(v) => auChangement(v as StatutEcheance)}
        options={STATUTS_CHOIX.map((s) => ({ value: s, label: libelleStatut(s) }))}
      />

      {saisiePartiel === "partiel" && (
        <div className="flex items-center gap-1">
          <input
            type="text"
            inputMode="decimal"
            aria-label="Part déjà réglée"
            value={montantRegle}
            disabled={enCours}
            onChange={(e) => setMontantRegle(e.target.value)}
            placeholder="Réglé"
            className={cn(champPetit, "w-24 text-right tabular-nums")}
          />
          <button
            type="button"
            disabled={enCours || !partielValide}
            onClick={() =>
              onChanger({
                echeanceId: echeance.id,
                statut: "partiel",
                montantRegle: montantRegle.trim().replace(",", "."),
              })
            }
            className={cn(
              "h-8 rounded-control px-2 text-xs font-semibold transition-colors",
              enCours || !partielValide
                ? "cursor-not-allowed bg-surface-inset text-text-faint"
                : "bg-primary text-text-onink hover:bg-primary-600",
            )}
          >
            OK
          </button>
          <button
            type="button"
            disabled={enCours}
            onClick={() => setSaisiePartiel(null)}
            className="h-8 rounded-control px-2 text-xs text-text-muted transition-colors
              hover:bg-surface-inset focus:outline-none focus-visible:ring-2 focus-visible:ring-primary"
          >
            Annuler
          </button>
        </div>
      )}
    </div>
  );
}

/** Fenêtre pendant laquelle le 2e clic est ignoré (rebond du clic d'armement). */
const ANTI_REBOND_MS = 350;
/** Sans confirmation dans ce délai, le bouton revient à l'état initial. */
const DESARMEMENT_MS = 5000;

/**
 * Suppression en DEUX TEMPS : le 1er clic ARME (« Confirmer ? », style danger),
 * le 2e supprime. Une échéance est saisie à la main — la détruire d'un seul clic
 * (DELETE physique, sans undo) transformait un mauvais clic en perte sèche.
 * Le bouton se désarme seul (5 s), au blur, ou à Échap ; le 2e clic est ignoré
 * pendant 350 ms pour qu'un double-clic nerveux ne confirme pas par accident.
 * Le gating VIEWER (`BoutonProtege`) est conservé tel quel.
 */
function BoutonSupprimerDeuxTemps({
  autorise,
  enCours,
  libelle,
  onSupprimer,
}: {
  autorise: boolean;
  /** Suppression déjà partie au serveur (désactive le bouton). */
  enCours: boolean;
  /** Libellé de l'échéance, pour un aria-label non ambigu. */
  libelle: string;
  onSupprimer?: () => void;
}) {
  const [armeDepuis, setArmeDepuis] = useState<number | null>(null);

  useEffect(() => {
    if (armeDepuis === null) return;
    const t = setTimeout(() => setArmeDepuis(null), DESARMEMENT_MS);
    return () => clearTimeout(t);
  }, [armeDepuis]);

  const arme = armeDepuis !== null;
  const gererClic = onSupprimer
    ? () => {
        if (enCours) return;
        if (armeDepuis === null) {
          setArmeDepuis(Date.now());
          return;
        }
        if (Date.now() - armeDepuis < ANTI_REBOND_MS) return;
        setArmeDepuis(null);
        onSupprimer();
      }
    : undefined;

  return (
    <BoutonProtege
      autorise={autorise}
      raison={RAISON_ECHEANCES}
      onClick={gererClic}
      disabled={enCours}
      aria-label={
        arme
          ? `Confirmer la suppression de « ${libelle} »`
          : `Supprimer « ${libelle} »`
      }
      onBlur={() => setArmeDepuis(null)}
      onKeyDown={(e) => {
        if (e.key === "Escape") setArmeDepuis(null);
      }}
      className={cn(
        "rounded-control px-2.5 py-1.5 text-[13px] font-medium transition-colors",
        "focus:outline-none focus-visible:ring-2 focus-visible:ring-primary",
        "disabled:opacity-[0.48]",
        arme
          ? "bg-danger-bg font-semibold text-danger hover:bg-danger-bg"
          : "text-text-muted hover:bg-danger-bg hover:text-danger",
      )}
    >
      {enCours ? "Suppression…" : arme ? "Confirmer ?" : "Supprimer"}
    </BoutonProtege>
  );
}

export function EcheancesList({
  echeances,
  nomParCategorie,
  peutGerer = true,
  onModifier,
  onSupprimer,
  suppressionEnCours = null,
  onChangerStatut,
  statutEnCours = null,
  idEnEdition = null,
}: {
  /** Sous-ensemble DÉJÀ filtré (une direction) + trié (exigibilité croissante). */
  echeances: EcheanceUI[];
  /** id catégorie → nom lisible (construit par le conteneur). */
  nomParCategorie: Map<string, string>;
  /** false = lecture seule (VIEWER) : pas de contrôle de statut ni de boutons. */
  peutGerer?: boolean;
  /** Ouvre l'édition (pré-remplit le formulaire du conteneur). */
  onModifier?: (echeance: EcheanceUI) => void;
  /** Supprime l'échéance (le conteneur appelle l'action). */
  onSupprimer?: (echeanceId: string) => void;
  /** id de l'échéance en cours de suppression (désactive son bouton), si une. */
  suppressionEnCours?: string | null;
  /** Transitionne le statut (+ part réglée si « partiel »). */
  onChangerStatut?: (input: ChangerStatutInputUI) => void;
  /** id de l'échéance dont le statut est en cours de changement, si une. */
  statutEnCours?: string | null;
  /** id de l'échéance actuellement éditée (mise en évidence), si une. */
  idEnEdition?: string | null;
}) {
  return (
    <ul className="flex flex-col divide-y divide-line rounded-control border border-line bg-surface-card">
      {echeances.map((e) => {
        const inflow = e.direction === "encaissement";
        const nomCat = e.categorieId
          ? (nomParCategorie.get(e.categorieId) ?? "Catégorie inconnue")
          : null;
        const enSuppression = suppressionEnCours === e.id;
        const changementStatut = statutEnCours === e.id;

        return (
          <li
            key={e.id}
            className={cn(
              "flex flex-wrap items-start gap-x-4 gap-y-2 px-4 py-3",
              e.id === idEnEdition && "bg-surface-inset",
            )}
          >
            {/* Identité : libellé + contrepartie + catégorie + date. */}
            <div className="flex min-w-0 flex-1 flex-col gap-1">
              <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm">
                <span className="truncate font-medium text-text">{e.libelle}</span>
                {e.contrepartie && (
                  <span className="truncate text-text-muted">· {e.contrepartie}</span>
                )}
                {nomCat && (
                  <CategoryBadge name={nomCat} colorKey={e.categorieId!} size="sm" />
                )}
                {e.recurrence && (
                  <span className="rounded-full bg-surface-inset px-2 py-0.5 text-xs font-medium text-text-muted">
                    {e.recurrence === "mensuelle" ? "Mensuelle" : "Trimestrielle"}
                  </span>
                )}
              </div>
              <div className="flex items-center gap-2 text-[13px] text-text-muted">
                <span className="tabular-nums">
                  Exigible le {formaterDateComptableLongue(e.dateEcheance)}
                </span>
              </div>
            </div>

            {/* Montant (coloré par le sens, jamais tronqué) + restant si partiel. */}
            <div className="flex shrink-0 flex-col items-end">
              <span
                className={cn(
                  "whitespace-nowrap text-sm font-semibold tabular-nums",
                  inflow ? "text-inflow" : "text-outflow",
                )}
              >
                {formatMontant(e.montant, e.devise)}
              </span>
              {e.statut === "partiel" && e.montantRegle && (
                <span className="whitespace-nowrap text-xs text-text-muted tabular-nums">
                  reste {montantNu(restantDecimal(e.montant, e.montantRegle))} ·
                  réglé {montantNu(e.montantRegle)}
                </span>
              )}
            </div>

            {/* Statut + actions. En lecture seule : badge simple, pas de contrôle. */}
            <div className="flex shrink-0 flex-col items-end gap-2">
              {peutGerer && onChangerStatut ? (
                <StatutControl
                  echeance={e}
                  enCours={changementStatut}
                  onChanger={onChangerStatut}
                />
              ) : (
                <EcheanceBadge statut={e.statutAffiche} />
              )}

              {/* Actions de MODIFICATION : visibles pour tous, INERTES pour un
                  VIEWER (convention D2 #37 — désactivé + tooltip, jamais caché).
                  Les handlers ne sont fournis par le conteneur que si `peutGerer` ;
                  on les rend donc conditionnels au rôle, pas à leur présence. */}
              <div className="flex items-center gap-1">
                {/* Rappel du statut d'affichage (dérivé « en retard ») à côté des
                    actions, même quand le contrôle montre le statut STOCKÉ. */}
                {onChangerStatut && e.enRetard && (
                  <EcheanceBadge statut="en_retard" className="mr-1" />
                )}
                <BoutonProtege
                  autorise={peutGerer}
                  raison={RAISON_ECHEANCES}
                  onClick={onModifier ? () => onModifier(e) : undefined}
                  className="rounded-control px-2.5 py-1.5 text-[13px] font-medium text-text-muted
                    transition-colors hover:bg-surface-inset hover:text-text
                    focus:outline-none focus-visible:ring-2 focus-visible:ring-primary"
                >
                  Modifier
                </BoutonProtege>
                <BoutonSupprimerDeuxTemps
                  autorise={peutGerer}
                  enCours={enSuppression}
                  libelle={e.libelle}
                  onSupprimer={onSupprimer ? () => onSupprimer(e.id) : undefined}
                />
              </div>
            </div>
          </li>
        );
      })}
    </ul>
  );
}
