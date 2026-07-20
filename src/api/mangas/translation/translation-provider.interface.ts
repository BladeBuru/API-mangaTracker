/**
 * Contrat commun des moteurs de traduction (Chantier A).
 *
 * Implémentations actuelles :
 * - `DeeplProvider` — DeepL API Free, actif uniquement si `DEEPL_API_KEY`
 *   est défini (primaire, meilleure qualité).
 * - `GtxProvider` — endpoint Google Translate non officiel `client=gtx`,
 *   zéro configuration (fallback / défaut).
 *
 * L'interface permet d'ajouter plus tard un 3ᵉ provider (ex. LibreTranslate
 * self-hosted sur le NAS) sans toucher au `DescriptionTranslationService`.
 */
export interface TranslationProvider {
  /** Nom court du provider (logs/debug) */
  readonly name: string;

  /**
   * Traduit `text` (anglais) vers `targetLang` (code primaire 2 lettres,
   * minuscule : fr, de, es, pt, ja, ko).
   *
   * @returns la traduction, ou `null` en cas d'échec (quota, réseau,
   * provider inactif…). Ne rejette JAMAIS : une traduction ratée ne doit
   * jamais produire de 5xx — le caller renverra la description originale.
   */
  translate(text: string, targetLang: string): Promise<string | null>;
}
