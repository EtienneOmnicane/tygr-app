/**
 * Normalisation du `viewFilter` (sélecteur de périmètre L8b-1) — logique PURE,
 * sans React ni Auth.js ni DB, donc testable unitairement (pattern « machine
 * pure séparée » du repo, cf. components/widget/machine-mfa.ts).
 *
 * RAPPEL DE CADRAGE (tenancy.ts:35-48) : le `viewFilter` est une INTENTION
 * d'affichage NON FIABLE. La SÉCURITÉ est la RLS — `withWorkspace` intersecte le
 * filtre avec le DROIT (account_scope) avant de poser le GUC, donc le filtre ne
 * peut QUE rétrécir la vue (jamais l'élargir, tenancy.ts:391-419). Cette
 * normalisation n'est donc PAS une barrière de sécurité : c'est de l'HYGIÈNE de
 * token (ne pas persister dans le JWT des UUID parasites/inexistants), par
 * cohérence avec basculerWorkspace qui re-valide la membership avant d'écrire.
 *
 * Convention « Groupe » : une liste vide après nettoyage ⇒ `undefined` (le champ
 * est retiré du token) ⇒ `withWorkspace` ne pose PAS le GUC ⇒ on voit tout le
 * DROIT. « Groupe » et « filtre dont aucun compte n'est visible » convergent donc
 * vers le même résultat — voulu (un filtre vidé n'est pas « 0 ligne » côté token).
 */
import { z } from "zod";

/**
 * Borne anti-abus du nombre de comptes filtrés. Alignée sur la borne `entityIds`
 * de admin/entites/actions.ts:89. Un workspace a un nombre fini de comptes ;
 * au-delà c'est forcément forgé → rejet bruyant.
 */
export const PERIMETRE_MAX_COMPTES = 200;

/**
 * Schéma STRICT du périmètre demandé (consommé par la Server Action
 * definirViewFilter). `bankAccountIds` = liste d'UUID de comptes ; `[]` est VALIDE
 * et signifie « Groupe » (aucun filtre). `.strict()` rejette tout champ en trop.
 * La liste est seulement VALIDÉE ici (forme/borne) ; l'INTERSECTION avec les
 * comptes réellement visibles se fait dans le callback jwt (normaliserViewFilter),
 * et la SÉCURITÉ reste la RLS (le serveur intersecte le GUC, tenancy.ts:391-419).
 */
export const perimetreSchema = z
  .object({
    bankAccountIds: z.array(z.string().uuid()).max(PERIMETRE_MAX_COMPTES),
  })
  .strict();

export type PerimetreValide = z.infer<typeof perimetreSchema>;

/**
 * Réduit une demande de filtre (issue du client, donc non fiable) à la liste
 * CANONIQUE à persister dans le token, ou `undefined` (= « Groupe »).
 *
 * - dédublonne (un même id deux fois ⇒ une fois) ;
 * - INTERSECTE avec `comptesAutorises` (les `bank_account_id` réellement visibles
 *   du membre dans le workspace courant, lus sous RLS) — un id hors de cette
 *   liste (autre tenant, compte révoqué/désélectionné, hors scope entité) est
 *   ÉLIMINÉ ;
 * - préserve l'ordre de `demande` (stable pour l'affichage / les comparaisons) ;
 * - liste résultante vide ⇒ `undefined` (« Groupe »), jamais `[]`.
 *
 * @param demande           ids demandés par le client (déjà validés en UUID par Zod en amont).
 * @param comptesAutorises  ids visibles du membre (source de vérité d'hygiène).
 */
export function normaliserViewFilter(
  demande: readonly string[],
  comptesAutorises: readonly string[],
): string[] | undefined {
  const autorises = new Set(comptesAutorises);
  const vus = new Set<string>();
  const garde: string[] = [];
  for (const id of demande) {
    if (autorises.has(id) && !vus.has(id)) {
      vus.add(id);
      garde.push(id);
    }
  }
  return garde.length > 0 ? garde : undefined;
}
