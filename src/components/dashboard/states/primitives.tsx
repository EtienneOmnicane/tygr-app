/**
 * COMPAT — les primitives d'état ont été promues vers `@/components/ui/states`
 * (transverses, réutilisables hors dashboard). Ce module ne fait que ré-exporter
 * la nouvelle source pour ne casser aucun import existant (`./primitives` et le
 * barrel `@/components/dashboard/states`). Aucune logique ici.
 *
 * Nouveau code : importer directement depuis `@/components/ui/states`.
 */
export {
  cn,
  SkeletonBlock,
  StateCard,
  StateIllustration,
  type StateIllustrationVariant,
} from "@/components/ui/states/primitives";
