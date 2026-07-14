/**
 * Validation du CHEMIN DE RETOUR interne (A4 / PERIMETRE-REDIRECT-PAGE1). Module
 * PUR — pas de `"use server"`, pas de React, pas d'env, pas de réseau — donc
 * testable unitairement, et la décision de sécurité ne vit pas dans le fichier
 * d'actions (calque `server/auth/view-filter.ts`, `components/widget/machine-mfa.ts`).
 *
 * POURQUOI. Le sélecteur de périmètre poste la page COURANTE (champ `origine`) pour
 * que « Appliquer » y REVIENNE, au lieu de téléporter au dashboard (`redirect("/")`
 * en dur). Ce chemin vient d'un CHAMP DE FORMULAIRE : il est FALSIFIABLE. Sans
 * validation, c'est un OPEN-REDIRECT — un tiers qui fait soumettre le formulaire à
 * une victime l'envoie sur `https://evil.example`, page qui imite TYGR et réclame
 * des identifiants. La RLS n'est pas concernée (le périmètre reste gardé par
 * `tenancy.ts`) : le risque est le phishing, pas la fuite de données.
 *
 * ⚠️ NE PAS CONFONDRE avec `src/server/widget/redirect-origin.ts`, qui valide une
 * ORIGINE EXTERNE (cible `postMessage` du PublicToken Omni-FI : allowlist + https).
 * Ici c'est le miroir : on n'accepte QUE de l'INTERNE et on ne rend JAMAIS d'origine.
 *
 * CONTRAT. Fonction TOTALE (ne jette jamais) et FAIL-CLOSED : tout ce qui n'est pas
 * PROUVÉ interne renvoie `null`, et l'appelant retombe sur `"/"` (le comportement
 * d'avant le correctif). Rejet SILENCIEUX, jamais énumérant (règle 3 : aucune erreur
 * ne révèle la forme attendue). Règle 8 : ce module ne logge rien — un chemin peut
 * porter des filtres, donc potentiellement de la PII.
 */

/**
 * Borne de longueur. Aucune route interne n'en approche (la plus longue est de
 * l'ordre de `/transactions?periode=12m`) ; 2048 est la limite d'URL de facto des
 * navigateurs. Au-delà, c'est forgé → rejet (et le repli `"/"` reste sûr).
 */
export const CHEMIN_INTERNE_LONGUEUR_MAX = 2048;

/**
 * Base de résolution SENTINELLE (règle 5 ci-dessous). `.invalid` est un TLD réservé
 * (RFC 2606) : il ne peut JAMAIS être une origine réelle — la comparaison d'origine
 * ne peut donc pas être satisfaite par accident, ni par un hôte attaquant.
 */
const BASE_SENTINELLE = "https://tygr.invalid";

/**
 * Caractères de contrôle (C0 + DEL). Écrit en BOUCLE plutôt qu'en regex : une classe
 * U+0000-U+001F déclencherait `no-control-regex`, et l'intention se lit mieux ainsi.
 */
function contientCaractereDeControle(v: string): boolean {
  for (let i = 0; i < v.length; i++) {
    const code = v.charCodeAt(i);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

/**
 * Réduit une valeur de formulaire à un chemin de redirection INTERNE sûr, ou `null`.
 *
 * @param brut  valeur brute d'un champ de formulaire (`formData.get(…)` : `string`,
 *              `File` ou `null`) — jamais fiable.
 * @returns     `pathname + search` (ex. `"/transactions?periode=3m"`), ou `null`.
 */
export function validerCheminInterne(brut: unknown): string | null {
  // 1. FORME — une chaîne non vide et bornée. `formData.get` peut rendre `null`
  //    (champ absent) ou un `File` (champ trafiqué) : tout ce qui n'est pas une
  //    chaîne est rejeté d'emblée.
  if (typeof brut !== "string") return null;
  if (brut.length === 0 || brut.length > CHEMIN_INTERNE_LONGUEUR_MAX) return null;

  // 2. CARACTÈRES DE CONTRÔLE — un CR/LF dans une valeur qui finit en en-tête
  //    `Location` est un vecteur d'injection d'en-tête (réponse coupée en deux) ;
  //    NUL/TAB servent à contourner les parseurs naïfs.
  if (contientCaractereDeControle(brut)) return null;

  // 3. ANTISLASH — jamais légitime dans un chemin interne, et c'est LE vecteur du
  //    faux-chemin `/\evil.example` : les parseurs WHATWG normalisent `\` en `/`
  //    pour les schémas spéciaux, donc `/\evil.example` devient `//evil.example`,
  //    une URL protocol-relative vers un hôte TIERS.
  if (brut.includes("\\")) return null;

  // 4. CHEMIN ABSOLU INTERNE (sur l'ENTRÉE) — commence par `/`, jamais par `//`.
  //    Écarte déjà TOUT schéma (`https:`, `javascript:`, `data:` — aucun ne commence
  //    par `/`), tout chemin relatif (`transactions`, `../x`) et la forme LITTÉRALE
  //    de l'URL protocol-relative (`//evil.example`). ⚠️ « sur l'entrée » : la forme
  //    DÉRIVÉE par normalisation est rattrapée par la règle 7, cf. son commentaire.
  if (!brut.startsWith("/") || brut.startsWith("//")) return null;

  // 5. DÉFENSE EN PROFONDEUR — on RÉSOUT contre la sentinelle et on exige que
  //    l'origine résolue soit EXACTEMENT la sienne. Le parseur WHATWG est plus
  //    permissif que les règles 2-4 : s'il existe une forme qui s'en évade, elle
  //    change forcément d'origine ici, donc elle est attrapée. Deux gardes
  //    indépendantes valent mieux qu'une regex qu'on croit exhaustive.
  let url: URL;
  try {
    url = new URL(brut, BASE_SENTINELLE);
  } catch {
    return null;
  }
  if (url.origin !== BASE_SENTINELLE) return null;

  // 6. SORTIE — `pathname + search` UNIQUEMENT (tous deux normalisés/percent-encodés
  //    par le parseur) :
  //    - jamais l'origine → le `Location` posé par Next reste RELATIF, donc même si
  //      la sentinelle fuitait, on ne pourrait pas envoyer la victime ailleurs ;
  //    - jamais le hash → il n'est pas transmis au serveur et n'a rien à faire dans
  //      une destination rejouée côté serveur.
  const chemin = `${url.pathname}${url.search}`;

  // 7. RE-VALIDATION DE LA SORTIE — LE point critique (constat cross-review 2026-07-14).
  //    On valide ce qu'on RETOURNE, pas seulement l'entrée brute. La normalisation
  //    des dot-segments par le parseur produit un `pathname` protocol-relative TOUT
  //    EN gardant l'origine sentinelle → la règle 5 est satisfaite mais la sortie
  //    enverrait la victime sur un hôte tiers :
  //        "/..//evil.example"      → pathname "//evil.example"
  //        "/%2e%2e//evil.example"  → pathname "//evil.example"  (%2e décodé en `.`)
  //        "/..///evil.example"     → pathname "///evil.example"
  //    `redirect("//evil.example")` de Next pose un `Location` que le navigateur
  //    résout en `https://evil.example/` (open-redirect). La règle 4 ne voyait que
  //    la forme LITTÉRALE en entrée ; ici on ferme la forme DÉRIVÉE, fail-closed.
  //    `chemin` commence toujours par `/` (pathname d'une URL http) → seul le `//`
  //    de tête est à rejeter.
  if (chemin.startsWith("//")) return null;

  return chemin;
}
