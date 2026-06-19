# Spec Technique — Stats

| Champ         | Valeur              |
|---------------|---------------------|
| Module        | stats               |
| Version       | 0.2.0               |
| Date          | 2026-06-19          |
| Source        | Rétro-ingénierie + sprint social/stats (Stats v2) |

## Architecture du module

Le module est de type **read-only aggregation** : aucune écriture, aucune table
dédiée. Il interroge trois repositories TypeORM existants (`User`, `UserManga`, `UserMangaChapterLog`) et
calcule l'ensemble des agrégats en mémoire applicative ou via QueryBuilder SQL dans `StatsService`.

Stats v2 (sprint social/stats) ajoute trois champs au payload : `genreCounts` (top 10 avec compteurs),
`readingHistory` (20 dernières sessions du journal chapter_log, skips exclus) et `chaptersPerWeek`
(8 semaines via `DATE_TRUNC('week', ...)` PostgreSQL). Le champ `topGenres` est conservé pour
compatibilité ascendante (top 5 extrait depuis `genreCounts`).

```
GET /user/stats
      │
      ▼
StatsController
  └── StatsService.getUserStats(userId)
        ├── userRepository.findOne()          → valide l'existence du user
        ├── userMangaRepository.find({ relations: ['manga'] })
        │     └── chargement de toute la biblio avec la relation manga
        ├── aggregateByStatus()               → Map des 4 statuts
        ├── totalChaptersRead                 → reduce sum
        ├── estimatedReadingTimeMinutes       → totalChapters × 4
        ├── computeGenreCounts()              → Map genre→count, top 10 (Stats v2)
        │     └── topGenres = genreCounts.slice(0,5).map(g => g.genre) (compat)
        ├── findLastReadAt()                  → max(lastUpdated)
        ├── computeCompletionRate()           → completed/engaged ratio
        ├── fetchReadingHistory(userId)       → 20 dernières sessions (Stats v2)
        │     QueryBuilder : order readAt DESC, take 20, where isSkip=false
        └── fetchChaptersPerWeek(userId)      → 8 semaines (Stats v2)
              QueryBuilder : DATE_TRUNC week, groupBy, orderBy, 8 dernières semaines
```

Le controller récupère l'identifiant utilisateur depuis `req.user` (injecté par
`JwtAuthGuard`) sans exposer de paramètre URL. L'utilisateur ne peut consulter
que ses propres données.

## Fichiers impactés

| Fichier | Rôle | Lignes |
|---------|------|--------|
| `src/api/user/stats/stats.service.ts` | Logique d'agrégation complète — inclut Stats v2 : `fetchReadingHistory`, `fetchChaptersPerWeek`, `computeGenreCounts` | ~175 |
| `src/api/user/stats/stats.controller.ts` | Exposition HTTP `GET /user/stats` | ~44 |
| `src/api/user/stats/stats.dto.ts` | Shape de la réponse (Swagger + sérialisation) — Stats v2 : `genreCounts`, `readingHistory`, `chaptersPerWeek` ajoutés | ~105 |
| `src/api/user/stats/stats.module.ts` | Déclaration du module NestJS — Stats v2 : importe `UserMangaChapterLog` dans `TypeOrmModule.forFeature` | ~22 |

## Schéma BDD (tables consommées)

Le module ne possède pas ses propres tables. Il lit en lecture seule :

**Table `user`** (colonnes utilisées)
| Colonne | Type | Usage |
|---------|------|-------|
| `id` | int | Clé de lookup |
| `created_at` | timestamp | Champ `accountCreatedAt` de la réponse |

**Table `user_manga`** (colonnes utilisées)
| Colonne | Type | Usage |
|---------|------|-------|
| `user_id` | int | Filtrage par utilisateur |
| `reading_status` | varchar | Agrégation par statut |
| `user_read_chapters` | int | Somme totale des chapitres lus |
| `last_updated` | timestamp | Max pour `lastReadAt` |
| `manga_id` | varchar | Clé de jointure vers `manga` |

**Table `manga`** (via relation TypeORM)
| Colonne | Type | Usage |
|---------|------|-------|
| `genres` | array/json | Comptage fréquences pour top genres (`genreCounts`, Stats v2) |

**Table `user_manga_chapter_log`** (Stats v2 — consommée via `chapterLogRepository`)
| Colonne | Type | Usage |
|---------|------|-------|
| `user_id` | int | Filtrage par utilisateur |
| `manga_id` | varchar | Clé de jointure vers `manga` (pour `mangaTitle`) |
| `chapter_number` | float/int | Numéro de chapitre — champ `chapterNumber` dans `readingHistory` |
| `is_bonus` | boolean | Indicateur chapitre bonus — champ `isBonus` dans `readingHistory` |
| `is_skip` | boolean | Skip utilisateur — filtre `where isSkip = false` dans `readingHistory` et `chaptersPerWeek` |
| `read_at` | timestamp | Horodatage de lecture — tri DESC pour `readingHistory`, `DATE_TRUNC('week', ...)` pour `chaptersPerWeek` |

## API / Endpoints

| Méthode | Route | Description | Auth |
|---------|-------|-------------|------|
| `GET` | `/user/stats` | Statistiques agrégées de l'utilisateur courant | JWT requis |

**Réponse 200 — `UserStatsDto`** (Stats v2 — champs `genreCounts`, `readingHistory`, `chaptersPerWeek` ajoutés)

```json
{
  "mangasByStatus": {
    "readLater": 8,
    "reading": 12,
    "caughtUp": 5,
    "completed": 34
  },
  "totalChaptersRead": 1245,
  "estimatedReadingTimeMinutes": 4980,
  "topGenres": ["Action", "Romance", "Comedy", "Drama", "Fantasy"],
  "lastReadAt": "2026-05-10T18:42:00.000Z",
  "completionRate": 0.662,
  "accountCreatedAt": "2024-08-15T12:30:00.000Z",
  "totalMangas": 59,
  "genreCounts": [
    { "genre": "Action", "count": 24 },
    { "genre": "Romance", "count": 17 }
  ],
  "readingHistory": [
    {
      "muId": 12345,
      "mangaTitle": "One Piece",
      "chapterNumber": 1118,
      "isBonus": false,
      "readAt": "2026-06-10T21:14:00.000Z"
    }
  ],
  "chaptersPerWeek": {
    "2026-06-08": 12,
    "2026-06-01": 7
  }
}
```

**Codes d'erreur**
| Code | Condition |
|------|-----------|
| 401 | Token absent ou invalide |
| 404 | `userId` extrait du token ne correspond à aucun utilisateur |

## Patterns identifiés

- **Compute-on-read sans matérialisation** : les agrégats ne sont pas stockés en
  base. Chaque appel recharge et recalcule. Commentaire explicite dans le code :
  volume modeste (< 500 mangas/user), agrégation < 50 ms en pratique.

- **Eager loading unique requête** : un seul `find` avec `relations: ['manga']`
  charge toute la bibliothèque. Pas de N+1 (pas de lazy loading).

- **Stabilité du payload** : `aggregateByStatus` initialise tous les statuts à 0
  avant de compter. Le client reçoit toujours les 4 clés, même si un statut est
  absent de la bibliothèque.

- **Heuristique 4 min/chapitre** : constante nommée `AVERAGE_MINUTES_PER_CHAPTER = 4`,
  documentée en commentaire (médiane issue d'enquêtes scanlation : ~15-20 pages,
  ~12-15 sec/page). Non configurable via env ou BDD — valeur en dur.

- **Injection par `@Inject()`** : le controller utilise `@Inject(StatsService)`
  (injection par token) plutôt que l'injection par constructeur habituelle de NestJS.
  Fonctionne mais est moins idiomatique que `constructor(private readonly service: StatsService)`.

- **`ClassSerializerInterceptor`** sur le controller : activé pour la transformation
  automatique de la réponse. Sans impact fonctionnel visible ici (pas d'`@Exclude`
  dans le DTO), mais cohérent avec la convention du projet.

## Algorithmes

### aggregateByStatus
Initialise un bucket pour chaque valeur de `ReadingStatus` (4 valeurs), puis
itère sur `userMangas`. Les mangas avec `readingStatus` null sont comptés dans
`ReadingStatus.ReadLater`.

### computeTopGenres
Parcourt chaque `UserManga`, accède à `manga.genres`, et incrémente un `Map<genre, count>`.
Trie par count décroissant, prend les 5 premiers, retourne les labels (pas les counts).
Genres null/vides filtrés.

### findLastReadAt
Itération linéaire sur `userMangas`, comparaison `Date > Date`. Retourne `null`
si aucun `lastUpdated` n'est renseigné.

### computeCompletionRate
- Numérateur : `completed`
- Dénominateur : `reading + completed + caughtUp`
- `readLater` exclu (wishlist non engagée)
- Arrondi via `toFixed(3)` → converti en `number` avec `Number(...)`

### computeGenreCounts (Stats v2)
Remplace `computeTopGenres` (conservée en interne pour `topGenres` compat). Parcourt chaque `UserManga`, accède à `manga.genres`, incrémente un `Map<genre, count>`. Trie par `count` décroissant, prend les 10 premiers, retourne les objets `{ genre, count }`. Le champ `topGenres` (top 5 labels) est extrait depuis `genreCounts.slice(0, 5).map(g => g.genre)` pour conserver la compatibilité ascendante.

### fetchReadingHistory (Stats v2)
QueryBuilder sur `user_manga_chapter_log` :
- `WHERE log.userId = :userId AND log.isSkip = false`
- `ORDER BY log.readAt DESC`
- `take 20` (limite fixe, pas de pagination)
- Jointure vers `manga` pour récupérer `manga.title`
- Retourne un tableau d'objets `{ muId, mangaTitle, chapterNumber, isBonus, readAt }`

### fetchChaptersPerWeek (Stats v2)
QueryBuilder sur `user_manga_chapter_log` :
- `SELECT TO_CHAR(DATE_TRUNC('week', log.readAt), 'YYYY-MM-DD') AS week, COUNT(*) AS count`
- `WHERE log.userId = :userId AND log.isSkip = false AND log.readAt >= :since` (since = 8 semaines avant maintenant)
- `GROUP BY DATE_TRUNC('week', log.readAt)`
- `ORDER BY DATE_TRUNC('week', log.readAt) ASC`
- Réduit en `Record<string, number>` (clé = lundi de la semaine ISO, valeur = nb sessions)

## Décisions techniques documentées (non-ADR)

Les décisions suivantes ont été identifiées mais ne satisfont pas la politique ADR
v2.3.0 (voir Rapport ADR dans `spec-fonctionnel.md`). Elles sont documentées ici.

**Heuristique 4 min/chapitre (AP-3)**  
Valeur codée en dur dans `stats.service.ts` ligne 14. Basée sur une estimation
médiane documentée en commentaire. Si une personnalisation par utilisateur ou une
valeur configurable est souhaitée, il faudra modifier uniquement ce fichier.

**Stratégie compute-on-read sans cache (AP-3 / heuristique d'implémentation)**  
Décision explicitement commentée dans le service et le DTO : pas de Redis pour le
MVP, invalidation sur add/remove/update de la biblio prévue si la charge augmente.
Confinée au module stats — non-architecturale au sens transverse.

**`@Inject()` au lieu de l'injection constructeur (AP-6 / style)**  
Le controller utilise `@Inject(StatsService)` au lieu de l'injection par constructeur.
Les deux sont équivalents dans NestJS. Le pattern constructeur (`private readonly`)
est la convention du reste du projet.

## Tests existants

| Fichier | Ce qu'il teste | Statut |
|---------|---------------|--------|
| `src/api/user/stats/*.spec.ts` | — | Absent |

Aucun test unitaire ni d'intégration n'a été trouvé pour ce module.
