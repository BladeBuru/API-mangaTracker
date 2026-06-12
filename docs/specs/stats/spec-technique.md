# Spec Technique — Stats

| Champ         | Valeur              |
|---------------|---------------------|
| Module        | stats               |
| Version       | 0.1.0               |
| Date          | 2026-06-04          |
| Source        | Rétro-ingénierie    |

## Architecture du module

Le module est de type **read-only aggregation** : aucune écriture, aucune table
dédiée. Il interroge deux repositories TypeORM existants (`User`, `UserManga`) et
calcule l'ensemble des agrégats en mémoire applicative dans `StatsService`.

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
        ├── computeTopGenres()                → Map genre→count, top 5
        ├── findLastReadAt()                  → max(lastUpdated)
        └── computeCompletionRate()           → completed/engaged ratio
```

Le controller récupère l'identifiant utilisateur depuis `req.user` (injecté par
`JwtAuthGuard`) sans exposer de paramètre URL. L'utilisateur ne peut consulter
que ses propres données.

## Fichiers impactés

| Fichier | Rôle | Lignes |
|---------|------|--------|
| `src/api/user/stats/stats.service.ts` | Logique d'agrégation complète | ~133 |
| `src/api/user/stats/stats.controller.ts` | Exposition HTTP `GET /user/stats` | ~44 |
| `src/api/user/stats/stats.dto.ts` | Shape de la réponse (Swagger + sérialisation) | ~67 |
| `src/api/user/stats/stats.module.ts` | Déclaration du module NestJS | ~21 |

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
| `genres` | array/json | Comptage fréquences pour top genres |

## API / Endpoints

| Méthode | Route | Description | Auth |
|---------|-------|-------------|------|
| `GET` | `/user/stats` | Statistiques agrégées de l'utilisateur courant | JWT requis |

**Réponse 200 — `UserStatsDto`**

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
  "totalMangas": 59
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
