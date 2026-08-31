/**
 * Mapping du payload `POST /v1/releases/search` de MangaUpdates.
 *
 * ## Sémantique vérifiée le 2026-08-29 (mesures, pas suppositions)
 *
 * 1. **`record.id` n'est PAS le `series_id`.** C'est l'identifiant de la
 *    SORTIE (~1 262 426 au 2026-08-29, incrémental). Les `series_id` MU sont
 *    des entiers à 11 chiffres (ex. 64156727159) ; `GET /v1/series/1262426`
 *    répond 404. Confondre les deux ferait échouer 100 % des rapprochements
 *    en silence — aucune ligne `manga` ne matcherait jamais.
 *
 * 2. **Le vrai `series_id` n'arrive qu'avec `include_metadata: true`**, sous
 *    `metadata.series.series_id`. Mesuré : 100/100 records d'une page en
 *    disposent. C'est la seule clé de rapprochement avec `manga.mu_id`.
 *
 * 3. **`time_added` est un OBJET**, pas une chaîne :
 *    `{ timestamp: 1787934483, as_rfc3339: '...', as_string: '...' }`. Le
 *    curseur du job s'appuie sur `timestamp` (epoch secondes, entier) — les
 *    deux autres formes sont des rendus humains, et `as_rfc3339` porte un
 *    décalage horaire PDT qui en ferait un curseur fragile.
 *
 * 4. **`release_date` est inexploitable comme curseur** : la base contient
 *    des dates aberrantes saisies à la main (`0001-07-05`, `1111-11-11`,
 *    `0004-04-07` — observées en triant la recherche par date ascendante).
 *    Seul `time_added` (horodatage d'insertion en base MU) est monotone.
 */

/** Forme utile d'un enregistrement `releases/search` (avec métadonnées). */
export interface MuReleaseResult {
  record?: {
    id?: number;
    title?: string;
    volume?: string | null;
    chapter?: string | null;
    time_added?: { timestamp?: number } | null;
  };
  metadata?: {
    series?: { series_id?: number | string | null } | null;
  } | null;
}

export interface MuReleasesBody {
  results?: MuReleaseResult[];
  total_hits?: number;
  page?: number;
  per_page?: number;
}

/** Une page de sorties, normalisée. */
export interface ReleasesPage {
  records: MuReleaseResult[];
  totalHits: number;
}

/** Sortie exploitable : série connue de MU + numéro de chapitre + horodatage. */
export interface ReleaseUpdate {
  /** `metadata.series.series_id`, en string pour coller à `manga.mu_id` (bigint). */
  muId: string;
  /** Numéro de chapitre entier retenu (voir `parseChapterNumber`). */
  chapter: number;
  /** `time_added.timestamp` — epoch secondes, base du curseur incrémental. */
  timeAdded: number;
}

/**
 * Extrait un numéro de chapitre exploitable d'un champ `chapter` MU, qui est
 * une chaîne libre saisie par les groupes de scan.
 *
 * Formes réellement observées sur un échantillon de 100 sorties consécutives
 * (2026-08-29) : `"166"` (92 %), `"12-13"` (5 %), `"12.5"` (1 %), `"18b"`
 * (1 %), `"112 + Afterword 1-3"` (1 %).
 *
 * Règles, dans cet ordre :
 *  - **plage `A-B`** → `B`, la borne HAUTE : une sortie « 12-13 » signifie que
 *    le chapitre 13 est paru ;
 *  - sinon → **premier nombre en tête de chaîne**, partie entière (`"12.5"`
 *    → 12, `"18b"` → 18, `"112 + Afterword 1-3"` → 112).
 *
 * Le « premier nombre » plutôt qu'un `max` sur tous les nombres de la chaîne
 * est délibéré : `"112 + Afterword 1-3"` donnerait le même résultat, mais une
 * forme du type `"5 (of 10)"` ferait bondir le total à 10 alors que seul le
 * chapitre 5 est paru. On préfère sous-estimer — `total_chapters` est monotone
 * croissant, une sous-estimation se corrige au prochain passage, une
 * surestimation est définitive.
 *
 * @returns Le numéro de chapitre, ou `null` si rien d'exploitable (`null`,
 *          `"Oneshot"`, `""`...). Une sortie sans numéro ne doit RIEN écrire.
 */
export function parseChapterNumber(
  raw: string | null | undefined,
): number | null {
  if (raw === null || raw === undefined) return null;
  const value = String(raw).trim();
  if (value === '') return null;

  const range = /^(\d+)\s*-\s*(\d+)$/.exec(value);
  if (range) {
    const high = Number.parseInt(range[2], 10);
    return Number.isFinite(high) && high > 0 ? high : null;
  }

  const leading = /^(\d+)/.exec(value);
  if (!leading) return null;
  const chapter = Number.parseInt(leading[1], 10);
  return Number.isFinite(chapter) && chapter > 0 ? chapter : null;
}

/**
 * Normalise une page de sorties en `ReleaseUpdate[]`, en écartant tout ce qui
 * n'est pas exploitable : pas de `series_id` dans les métadonnées, pas de
 * chapitre parsable, pas d'horodatage.
 *
 * **Dédoublonnage par série** : une même série peut publier plusieurs
 * chapitres dans la même fenêtre. On ne garde que le **plus haut** numéro par
 * `mu_id`, avec l'horodatage le plus récent — inutile d'émettre 3 UPDATE
 * `GREATEST` successifs là où un seul suffit.
 */
export function extractReleaseUpdates(
  records: MuReleaseResult[],
): ReleaseUpdate[] {
  const byMuId = new Map<string, ReleaseUpdate>();

  for (const item of records) {
    const seriesId = Number(item?.metadata?.series?.series_id);
    if (!Number.isFinite(seriesId) || seriesId <= 0) continue;

    const chapter = parseChapterNumber(item?.record?.chapter);
    if (chapter === null) continue;

    const timeAdded = Number(item?.record?.time_added?.timestamp);
    if (!Number.isFinite(timeAdded) || timeAdded <= 0) continue;

    const muId = String(seriesId);
    const existing = byMuId.get(muId);
    if (!existing) {
      byMuId.set(muId, { muId, chapter, timeAdded });
      continue;
    }
    byMuId.set(muId, {
      muId,
      chapter: Math.max(existing.chapter, chapter),
      timeAdded: Math.max(existing.timeAdded, timeAdded),
    });
  }

  return [...byMuId.values()];
}

/**
 * Plus grand `time_added` d'une page brute — calculé sur les records BRUTS et
 * non sur les `ReleaseUpdate` filtrés.
 *
 * C'est important : une sortie sans chapitre parsable est ignorée pour
 * l'écriture, mais elle a bien été VUE. Si le curseur ne l'englobait pas, elle
 * serait re-parcourue chaque nuit indéfiniment.
 */
export function maxTimeAdded(records: MuReleaseResult[]): number {
  let max = 0;
  for (const item of records) {
    const ts = Number(item?.record?.time_added?.timestamp);
    if (Number.isFinite(ts) && ts > max) max = ts;
  }
  return max;
}
