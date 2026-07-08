# Capture des logs widget Omni-FI (pour le support Omni-FI / Garrick)

But : fournir à Omni-FI la **console navigateur + le réseau (HAR)** au moment où le
widget de connexion plante ou échoue. Le crash se produit **dans l'iframe cross-origin
du CDN Omni-FI** (`omni-fi-connect.js`), pas dans notre code TYGR — donc ni nos logs
serveur ni un logger applicatif ne le voient. Seule une capture **au niveau navigateur**
l'expose.

## Réglages DevTools (AVANT de reproduire)

1. Ouvrir `/banques` dans Chrome, puis DevTools (`⌘⌥I`).
2. Onglet **Network** : cocher **Preserve log** + **Disable cache**, enregistrement actif.
3. Onglet **Console** : ⚙️ → **Preserve log** ; filtre de niveau sur **All levels** (inclure Verbose).

## Reproduire

4. « Connecter une banque » → la banque visée → identifiants → aller jusqu'au crash/échec.
5. Noter l'**heure exacte** (HH:MM:SS) + le **connectionId** et le **jobId** s'ils sont
   visibles. Omni-FI aligne ses logs serveur par timestamp/ID.

## Capturer au moment du crash

6. Network : clic droit sur une requête → **Save all as HAR with content** → fichier.
7. Console : clic droit dans la console → **Save as…** → fichier texte.
8. **Capture d'écran** de l'état planté.

## Deux pièges

- Console qui n'affiche que **« Script error. »** sans stack = erreur de l'iframe
  cross-origin Omni-FI. Utiliser le **sélecteur de contexte** en haut à gauche de la
  console (« top ») → choisir l'iframe `omni-fi` et relire les erreurs. Le HAR capture
  le réseau de l'iframe quoi qu'il arrive.
- Le HAR contient le **SessionToken** (Bearer) et le POST de login bancaire →
  **envoi privé à Omni-FI uniquement**, jamais collé en public. C'est leur domaine, donc
  côté secrets c'est acceptable pour eux ; ne pas le diffuser ailleurs (règle 8).

## Ce qu'on cible par banque (fil Garrick, 2026-07)

| Cas | Symptôme observé | Ce que la capture doit montrer |
|---|---|---|
| **MCB perso** — « widget crash » | Échec avant tout compte (timeout post-login OU erreur MCB « unable to carry out your request ») | La **pièce que Garrick attend** : est-ce le widget qui mal-gère l'état d'erreur, ou autre chose. Console (uncaught + stack via contexte iframe) + HAR (la requête MCB qui échoue + le corps de la réponse d'erreur). |
| **MCB Business** — comptes OK, pas de tx | Job `RETRIEVING` ~24 min → **failed** (77 comptes, dépasse la limite par run) | Diagnostiqué côté Omni-FI ; fix en cours (reprise en plusieurs passes). Capture non requise. |
| **Absa perso** — 0 compte | Extracteur renvoie `[]` et signale à tort un succès | Bug côté Omni-FI confirmé ; fix en cours. Capture non requise. |
| **Absa Pro** — pas de compte | En développement actif côté Omni-FI (OTP 8 chiffres, 2 pré-remplis) | Rien à capturer. |

## À envoyer à Garrick

- Le **HAR** + le **console.txt** + la **capture d'écran**.
- **Timestamp** exact + **connectionId/jobId** de la tentative.
- Une phrase : quelle banque, à quel écran ça a planté, ce que l'utilisateur voit.
