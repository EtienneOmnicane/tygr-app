# Feedback Front → Back : câblage UI assignation des entités (L3/L4)

Contexte : câblage de l'écran `/admin/entites` (PR `feat/ui-admin-wiring`) sur les
Server Actions/requêtes mergées par #86. Le câblage est fait à ~90 %. Deux demandes
côté serveur pour finir proprement.

## 1. ⛔ BLOQUANT — requête « lister les membres d'un workspace » manquante

L'écran a besoin, pour un workspace donné, de **la liste de ses membres**
(`userId`, nom complet, email, rôle). Or aucune fonction ne l'expose :

- `repositories/identite.ts` → `MembershipAvecNom` liste les workspaces **d'un
  utilisateur** (l'inverse de ce qu'il nous faut).
- `repositories/entites.ts` → `listerEntites`, `listerScopesMembre(userId)` existent,
  mais pas de liste de membres.

**Demande** : une fonction repo + ré-export `@/server/db`, p.ex.

```ts
export interface MembreWorkspaceLu {
  userId: string;
  nomComplet: string;   // ou fullName
  email: string;
  role: WorkspaceRole;
  scope: string[];      // entityIds ; [] = Vision Globale (idéalement joint ici)
}
export async function listerMembresWorkspace(tx, ctx): Promise<MembreWorkspaceLu[]>
```

Idéalement, `scope` est **joint dans la même requête** (LEFT JOIN
`member_entity_scopes`), ce qui supprime côté Front la boucle N+1 actuelle
(`Promise.all(membres.map(listerScopesMembre))`). ADMIN-only (même garde que
`listerEntites`).

En attendant : la page utilise `MEMBRES_MOCK` (UUID factices). Un enregistrement
réel renvoie alors `MembreNonScopableError` → « Ressource introuvable » (géré
proprement par l'UI). Remplacement = 1 appel, l'UI ne bouge pas.

## 2. ⚠️ Revalidation après écriture (`definirScopesAction`)

Après un `definirScopesAction` réussi, la page RSC n'est pas revalidée : le
`scopeInitial` (SSR) reste l'ancien, donc l'UI affiche le succès mais considère
toujours la carte « modifiée » jusqu'au prochain refresh. Un
`revalidatePath("/admin/entites")` (ou `revalidateTag`) en fin d'action
resynchroniserait l'état initial. Côté serveur (votre périmètre).

## 3. ℹ️ Convention `[]` = Vision Globale — OK, alignée

L'UI s'est alignée sur votre convention serveur (`entityIds = []` ⇒ Vision Globale,
aucune ligne `member_entity_scopes`). Garde-fou ajouté côté UI : on **empêche**
d'enregistrer un membre en mode « Vision Entité » avec 0 case cochée (sinon `[]`
partirait et rouvrirait tout l'accès, à l'encontre de l'intention). Pas d'action
attendue de votre côté, c'est noté pour cohérence.
