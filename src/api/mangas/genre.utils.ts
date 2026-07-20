/**
 * Forme brute d'un genre côté MangaUpdates : selon l'endpoint, MU renvoie
 * `[{genre: "Action"}]` (search/détail) ou parfois directement `["Action"]`.
 */
type RawGenre = string | { genre?: string; name?: string } | null | undefined;

/**
 * Normalise la liste de genres MU vers un `string[]` homogène pour stockage
 * en BDD et requêtage uniforme (`genres::jsonb ?| ...`).
 *
 * Sémantique (héritée de `Manga.fromMU` et `MangasService.getMangaDetails`,
 * dédupliquée ici) :
 * - `null`/`undefined` → `[]` (traité comme liste vide, pas comme inconnu) ;
 * - valeur non-array → `null` ;
 * - array → entrées mappées (string directe ou `.genre`/`.name`), les vides
 *   filtrées.
 */
export function normalizeGenres(rawGenres: unknown): string[] | null {
  const source = rawGenres ?? [];
  if (!Array.isArray(source)) return null;
  return (source as RawGenre[])
    .map((g) => (typeof g === 'string' ? g : g?.genre ?? g?.name ?? ''))
    .filter((g): g is string => typeof g === 'string' && g.length > 0);
}
