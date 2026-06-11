# DESIGN.md — TYGR

La source de vérité du design system est **`docs/UI_GUIDELINES.md`** (extraite du
benchmark FYGR le 2026-06-11, validée via /design-consultation).

Résumé exécutif :
- **Chose mémorable** : clarté financière — "j'ai compris ma trésorerie en 3 secondes".
- **Layout** : asymétrique — side-panel KPIs fixe 300px (sticky, collapsible) +
  zone de données défilante ; top-nav `ink` #0F1E3D ; une seule ancre par écran.
- **Typo** : Instrument Sans (UI) + Geist `tabular-nums` (tout montant) +
  JetBrains Mono (identifiants techniques). Jamais Inter/Roboto/system-ui.
- **Couleurs** : entrées `#16A34A` / sorties `#DC2626` réservés à la donnée ;
  marque = `ink` + accent ambre `#F59E0B` (nav active, jamais sur la donnée) ;
  prévisionnel = fond `#F6F8FB` + opacité 45% + label, jamais la couleur seule.
- **Densité** : cartes p-24, tables 44px/13px, matrice 40px, montants tabular
  alignés à droite.
- **Composants clés** : matrice de flux pivot (colonne sticky, synthèse sticky,
  lignes extensibles prof. 2, zone prévision grisée), courbe de trésorerie ancre
  (~55vh), panneau audit temps réel (360px, aria-live).

Toute nouvelle vue passe la checklist §6 de `docs/UI_GUIDELINES.md`.
