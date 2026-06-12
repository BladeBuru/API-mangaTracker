# Spec Fonctionnelle — Recommendations [DRAFT — à valider par le dev]

| Champ      | Valeur              |
|------------|---------------------|
| Module     | recommendations     |
| Version    | 0.1.0               |
| Date       | 2026-06-04          |
| Auteur     | retro-documenter    |
| Statut     | DRAFT               |
| Source     | Rétro-ingénierie    |

> **[DRAFT — à valider par le dev]** Cette spec a été générée par rétro-ingénierie
> à partir du code existant. Elle doit être relue et validée par un développeur
> qui connaît le contexte métier.

---

## ADRs

| ADR | Titre | Catégorie | Statut |
|-----|-------|-----------|--------|
| [RETRO-012](../../adr/RETRO-012-reco-scoring-weighted-multiplier.md) | Scoring pondéré statut × récence × note | DB-STRATEGY | Documenté (rétro) |

---

## Contexte et objectif

Le module recommendations produit des suggestions de mangas personnalisées pour chaque utilisateur à partir de sa bibliothèque. Plutôt que de remplacer la note brute MangaUpdates par un calcul local, il s'appuie sur les relations de recommandations déjà stockées dans `manga_recommendation` (pool MU) et les pondère par les signaux d'affinité propres à l'utilisateur (statut de lecture, note personnelle, ancienneté de l'ajout).

Le module gère également le cas des utilisateurs sans bibliothèque (cold start) et expose des pépites récentes peu visibles (sleeper hits).

---

## Règles métier (déduites du code)

### Scoring personnalisé

1. **Multiplicateur de statut** : les recommandations issues d'un manga `completed` (×1.5) ou `caughtUp` (×1.3) ont plus de poids que celles issues d'un manga `reading` (×1.2) ou `readLater` (×0.8). Un statut inconnu vaut ×1.0.

2. **Multiplicateur de récence** : le poids d'un manga source décroît exponentiellement avec l'ancienneté de son ajout en bibliothèque. La demi-vie est de 365 jours (un manga ajouté il y a un an vaut ~0.37 d'un manga ajouté aujourd'hui). Les goûts récents comptent plus.

3. **Multiplicateur de note personnelle** : si l'utilisateur a noté un manga, `user_rating / 5.0` est appliqué comme facteur. Un manga non noté vaut 1.0 (neutre).

4. **Score total d'un manga candidat** : somme des contributions de chaque manga source de la bibliothèque. Contribution d'une source = `weight_MU × ratingMultiplier × statusMultiplier × recencyMultiplier`.

5. **Cap par source (diversité)** : un manga source ne contribue qu'au maximum 30 de ses recommandations les mieux notées par MangaUpdates. Si le pool final est inférieur à 50 candidats, ce cap est relaxé à 60 pour éviter un écran vide (cap adaptatif).

6. **Exclusion stricte de la bibliothèque** : tout manga déjà présent dans la bibliothèque de l'utilisateur est exclu des candidats, sans exception.

7. **Explicabilité** : chaque résultat porte un champ `recommendedBecauseOf` listant les titres des 3 mangas sources ayant le plus contribué au score.

### Filtrage par genre

8. **Filtre genre optionnel** : `GET /recommendations?genre=Action` filtre les candidats sur correspondance exacte (case-insensitive) dans le tableau `genres` du manga. Le filtre est appliqué après le scoring complet pour ne pas biaiser le pool.

9. **Vue segmentée par genre** : `GET /recommendations/by-genre` regroupe les recos par genre, retourne les `topGenres` genres les plus représentés (défaut : 5) avec `perGenre` mangas chacun (défaut : 10). Un manga multi-genre apparaît dans chaque section concernée.

10. **Filtrage NSFW** : les genres `Adult`, `Mature`, `Hentai`, `Smut`, `Yaoi`, `Yuri`, `Ecchi` sont systématiquement exclus de la vue segmentée.

### Cold start (bibliothèque vide)

11. **Top communauté** : si l'utilisateur n'a aucun manga en bibliothèque, on remonte les mangas avec au moins 5 votes locaux, triés par note bayésienne agrégée décroissante.

12. **Sleepers en complément** : jusqu'à 30 sleeper hits sont concaténés après le top communauté, dédupliqués, pour enrichir l'écran home sans personnalisation.

### Sleeper hits

13. **Critères sleeper** : manga de l'année courante ou des 2 années précédentes (`year >= currentYear - 2`), note MU ≥ 7.5, apparaissant dans moins de 5 lignes de la table `manga_recommendation` (faible visibilité communautaire).

14. **Score sleeper** : `aggregatedRating × log(localVoteCount + 2) × exp(-(currentYear - year) / 2)`. Favorise les sorties très récentes par rapport à celles de l'année N-2.

15. **Exclusion bibliothèque** : les mangas déjà en biblio sont exclus. Pour le cold start, la bibliothèque est considérée vide (userId sentinelle -1).

### Stratégie cache

16. **Cache prioritaire** : si des recommandations sont en cache pour un manga source, elles sont utilisées directement. Les mangas non cachés sont soumis à un fetch MU en arrière-plan (non bloquant).

17. **Fetch bloquant si tout est vide** : si aucun manga source n'a de cache, un fetch MU bloquant est déclenché par batchs de 5 avec un timeout de 15 secondes par requête. Un échec de fetch est loggué en warn et ne bloque pas la réponse.

---

## Cas d'usage (déduits)

### CU-001 — Recommandations personnalisées (flux principal)

**Acteur** : utilisateur authentifié avec une bibliothèque non vide.

**Flux** :
1. `GET /recommendations?limit=50&offset=0`
2. Le service charge la bibliothèque de l'utilisateur.
3. Pour chaque manga source, il tente le cache. Les non-cachés sont traités en background.
4. Le scoring est calculé (statut × récence × note × weight MU).
5. Si le pool < 50 candidats, le cap par source est relaxé.
6. Résultat trié par score décroissant, paginé, avec `recommendedBecauseOf`.

### CU-002 — Cold start (première utilisation)

**Acteur** : utilisateur sans bibliothèque.

**Flux** :
1. `GET /recommendations`
2. La bibliothèque est vide → branche cold start.
3. Top communauté (≥ 5 votes locaux) trié par note agrégée.
4. Complété par jusqu'à 30 sleeper hits.
5. Déduplication et pagination.

### CU-003 — Vue home segmentée par genre

**Acteur** : application Flutter pour la home screen.

**Flux** :
1. `GET /recommendations/by-genre?topGenres=5&perGenre=10`
2. Le service calcule le scoreMap complet (mêmes règles que CU-001).
3. Groupement par genre, tri des genres par volume de candidats.
4. Exclusion NSFW. Top 5 genres, 10 mangas par genre.
5. Retour d'une map `{ genre: MangaQuickViewDto[] }`.

### CU-004 — Pépites cachées (sleeper hits)

**Acteur** : utilisateur cherchant des découvertes récentes.

**Flux** :
1. `GET /recommendations/sleepers?limit=20`
2. Chargement de la bibliothèque pour exclusion.
3. Candidats : mangas récents (≤ 2 ans) bien notés (≥ 7.5).
4. Filtre visibilité : < 5 occurrences dans `manga_recommendation`.
5. Calcul du score sleeper, tri décroissant.

---

## Format de réponse

Tous les endpoints retournent des `MangaQuickViewDto` :

| Champ | Type | Description |
|-------|------|-------------|
| `muId` | number | ID MangaUpdates |
| `title` | string | Titre |
| `year` | number | Année de sortie (0 si stub non résolu) |
| `mediumCoverUrl` | string | URL cover (vide si stub non résolu) |
| `largeCoverUrl` | string | URL cover large (alias medium en attendant enrichissement) |
| `rating` | number | Note MU (0 si non disponible) |
| `communityRating` | number? | Note moyenne locale (null si aucun vote) |
| `communityRatingCount` | number? | Nombre de votes locaux |
| `aggregatedRating` | number? | Note bayésienne agrégée MU + locaux |
| `recommendedBecauseOf` | string[]? | Titres des 3 mangas sources principaux |

---

## Dépendances

- `MangasService` — `getCachedRecommendations()`, `fetchAndCacheRecommendations()`, `getCommunityRatings()` (note bayésienne agrégée)
- `UserManga` entity — bibliothèque utilisateur avec `readingStatus`, `user_rating`, `adding_date`
- `MangaRecommendation` entity — table `manga_recommendation` (pool MU)
- `Manga` entity — métadonnées (titre, genres, covers, year, rating)
- `RecommendationModule` exporte `RecommendationService` (utilisé par d'autres modules éventuels)

---

## Zones d'incertitude

> Les points suivants n'ont pas pu être déterminés par le code seul :

- **Fréquence de rafraîchissement du cache MU** : le code lit et écrit en cache via `MangasService`, mais la durée de vie des entrées n'est pas visible dans ce module — nécessite lecture de `mangas.service.ts`.
- **Stubs non résolus** : `year=0`, `mediumCoverUrl=''` indiquent des mangas en attente d'enrichissement via `getMangaDetails`. Le délai entre création du stub et enrichissement n'est pas documenté ici.
- **Pertinence métier de la demi-vie 365 jours** : la valeur est dans le code mais le contexte business (calibrage empirique ? décision de conception ?) n'est pas documenté.
- **Plafond MAX_LIMIT=500** : le Swagger documente "max 100" sur le paramètre `limit`, mais le code applique 500. La cohérence client/serveur est à vérifier.
- **Genres NSFW hardcodés** : la liste est inline dans `buildUserRecommendationsByGenre`. Il n'existe pas de table ou enum centralisé — à confirmer si d'autres endroits du code l'utilisent.
