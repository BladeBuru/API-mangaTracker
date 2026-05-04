# Recommandations — Designs d'évolution

État au moment de l'écriture : feature recommandations livrée à ~95% (P0/P1/P2 + agrégation notes globales/locales). Ce document décrit les 2 prochaines features pour validation utilisateur avant implémentation.

---

## Feature A — Segmentation par genre

### Objectif

Aujourd'hui `GET /recommendations` retourne une liste plate triée par score. L'utilisateur veut pouvoir **filtrer ou voir des sections** par genre (action, romance, comédie, drame, fantastique…).

### Approches possibles

| Approche | Description | Pour | Contre |
|----------|-------------|------|--------|
| **A1. Query param `?genre=`** | `GET /recommendations?genre=action&limit=20` | Simple, RESTful, pagination par genre | Le client doit appeler N fois (un par genre affiché en home) |
| **A2. Endpoint structuré** | `GET /recommendations/by-genre` retourne `{action: [...], romance: [...], comedy: [...]}` | 1 seul appel home, UX fluide | Plus opaque, moins flexible (pagination par section difficile) |
| **A3. Hybride (recommandé)** | A2 pour la home (sections), A1 pour la page « Voir tout » d'un genre | Meilleur des deux | Deux endpoints à maintenir |

### Modèle de données

Aucune nouvelle table. On utilise les genres déjà stockés dans `MangaUpdates → muObject['genres']` qu'on remap dans `MangaDetailsDto.genres: string[]`.

**Décision** : ajouter `genres` à `Manga` entity (colonne `genres: string[]` JSON) pour requêter sans rappeler l'API MU.

```typescript
@Column({ type: 'json', nullable: true })
genres: string[] | null;
```

Migration TypeORM nécessaire (sans `synchronize: true`).

### Algorithme

1. `RecommendationService.buildUserRecommendations` produit le scoreMap habituel.
2. Nouveau : `buildUserRecommendationsByGenre(userId, topGenres = 5, perGenre = 10)` :
   - Calcule le scoreMap.
   - Pour chaque manga candidat : récupère ses genres depuis `Manga.genres`.
   - Regroupe les recommandations par genre (un manga peut apparaître dans plusieurs genres — c'est OK pour la home).
   - Trie chaque groupe par score.
   - Sélectionne les `topGenres` genres avec le plus de candidats au-dessus d'un seuil.
   - Retourne `Map<genre, MangaQuickViewDto[]>` limité à `perGenre` chacun.

### Endpoints

```typescript
// A1
GET /recommendations?genre=action&limit=20&offset=0
→ MangaQuickViewDto[]

// A2
GET /recommendations/by-genre?topGenres=5&perGenre=10
→ {
    "Action": MangaQuickViewDto[],
    "Romance": MangaQuickViewDto[],
    ...
  }
```

### UI Flutter

- Home : sous la section « Recommandé pour toi », **N sections horizontales** (une par genre détecté, ex: « Action », « Romance », « Drame »).
- Tap sur le titre d'une section → page « Voir tout » qui appelle `/recommendations?genre=X` avec pagination.

### Estimation

- Backend : **~3-4 h** (entité Manga.genres, migration, méthode service, endpoint, tests).
- Frontend : **~2-3 h** (BLoC sections, view, navigation, page « Voir tout », i18n).

### Risques

- Liste de genres MU **non normalisée** : « Action », « action », « Action/Adventure » peuvent coexister. Prévoir une normalisation côté API (lowercase + mapping de synonymes).
- Genres NSFW déjà filtrés dans `NSFW_GENRES` — vérifier qu'on les exclut aussi du regroupement.

---

## Feature B — Sleeper hits

### Objectif

Détecter les **nouveautés** qui ont peu de recommandations (peu de poids dans le graphe MU) **mais** sont très bien notées par les premiers lecteurs (locaux ou globaux). Ce sont des coups de cœur cachés que l'algorithme actuel **rate** parce qu'il s'appuie sur les recommandations communautaires (cumulatives par construction → biaisées vers les mangas anciens et populaires).

### Heuristiques de détection

Un manga est un « sleeper hit » candidat si :

1. **Récent** : `manga.year >= currentYear - 2` (sortie il y a 2 ans max).
2. **Note élevée** : `aggregatedRating >= 7.5` (Bayesian, donc résistant aux biais des notes peu nombreuses).
3. **Faible visibilité** : peu d'apparitions dans le graphe `MangaRecommendation`. Mesure : `SELECT COUNT(*) FROM manga_recommendation WHERE recommended_mu_id = X` — si < 5, le manga est rarement recommandé par d'autres.
4. **Filtre user** : pas déjà dans la bibliothèque user.
5. **Optionnel — boost local** : `communityRatingCount` > 0 et `communityRating >= 8` → priorité (au moins un user local l'a aimé).

### Score

```
sleeperScore = aggregatedRating × log(communityRatingCount + 2) × recencyBoost
```

Où `recencyBoost = exp(-(currentYear - manga.year) / 2)`.

Garde-fou : si `aggregatedRating == 0` (pas de note du tout), score = 0 → exclu.

### Endpoint

```typescript
GET /recommendations/sleepers?limit=20
→ MangaQuickViewDto[] (with sleeperScore as new optional field?)
```

Authent JWT (mêmes règles que `/recommendations`).

### Algorithme

```typescript
async findSleeperHits(userId: number, limit = 20): Promise<MangaQuickViewDto[]> {
  const currentYear = new Date().getFullYear();
  const userMangas = await this.userMangaRepository.find({ where: { user: { id: userId } } });
  const libraryMuIds = new Set(userMangas.map(um => um.manga.mu_id));

  // 1. Candidats : mangas récents avec rating MU élevé
  const candidates = await this.mangaRepository
    .createQueryBuilder('m')
    .where('m.year >= :yearMin', { yearMin: currentYear - 2 })
    .andWhere('m.rating >= :ratingMin', { ratingMin: 7.5 })
    .andWhere('m.mu_id NOT IN (:...lib)', { lib: Array.from(libraryMuIds) })
    .getMany();

  if (candidates.length === 0) return [];

  // 2. Recommandation count pour chaque candidat (pour mesurer la "cachette")
  const muIds = candidates.map(c => c.mu_id);
  const recoCounts = await this.recoRepository
    .createQueryBuilder('r')
    .select('r.recommended_mu_id', 'mu_id')
    .addSelect('COUNT(*)', 'count')
    .where('r.recommended_mu_id IN (:...ids)', { ids: muIds })
    .groupBy('r.recommended_mu_id')
    .getRawMany();

  const recoCountMap = new Map(recoCounts.map(r => [r.mu_id, parseInt(r.count, 10)]));

  // 3. Filtre "cachés" : seulement ceux avec < 5 recommandations
  const hidden = candidates.filter(c => (recoCountMap.get(c.mu_id) ?? 0) < 5);

  // 4. Enrichissement community rating
  const muRatings = new Map(hidden.map(m => [m.mu_id, Number(m.rating)]));
  const community = await this.getCommunityRatings(
    hidden.map(m => m.mu_id),
    muRatings,
  );

  // 5. Score sleeper
  const scored = hidden.map(m => {
    const c = community.get(m.mu_id);
    const aggregated = c?.aggregatedRating ?? Number(m.rating);
    const localCount = c?.communityRatingCount ?? 0;
    const recency = Math.exp(-(currentYear - m.year) / 2);
    const score = aggregated * Math.log(localCount + 2) * recency;
    return { manga: m, score, aggregated, localCount };
  });

  // 6. Top N
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit).map(s => /* DTO build */);
}
```

### UI Flutter

- Home : nouvelle section « Pépites cachées » ou « À découvrir ».
- DTO réutilise `MangaQuickViewDto` avec un champ optionnel `isSleeperHit?: boolean` pour badging UI (« 🔥 Pépite »).

### Estimation

- Backend : **~2-3 h** (méthode service + endpoint + tests).
- Frontend : **~1-2 h** (section home + i18n + badge).

### Risques

- **Manque de données** : si la BDD `Manga` n'a pas beaucoup de mangas récents (la sync MU est partielle), peu de candidats. Mitiger : trigger une sync MU des mangas récents en background quand l'endpoint est appelé.
- **Faux positifs** : un manga avec note 9.0 et 1 votant n'est pas fiable. Le `communityRatingCount + 2` dans le log atténue mais ne supprime pas. Considérer un seuil minimum `communityRatingCount >= 3` ou `MU rating >= 7.5` pour éviter les noise.

---

## Ordre d'implémentation recommandé

1. **Sleeper hits** (smaller, plus impactant) — 4-5 h
2. **Segmentation par genre** (plus de touches) — 6-7 h

Total : ~10-12 h pour les deux features complètes.

---

## Wire-up notation utilisateur (en attente)

Le widget `UserRatingStars` est créé. La méthode `LibraryService.updateRating(muId, rating)` existe. Reste à :

1. Ajouter `userRating` dans `MangaDetailDto` Flutter (parsing depuis `userRating` API).
2. Ajouter event `UpdateUserRating(muId, rating)` dans `DetailBloc`.
3. Handler du BLoC : appel `_libraryService.updateRating(muId, rating)`, émettre `state.copyWith(userRating: rating)`.
4. Dans `detail_bloc_view.dart`, sous le bouton « Add to library », afficher `UserRatingStars(rating: state.userRating, onRatingChanged: (r) => bloc.add(UpdateUserRating(...)))` UNIQUEMENT si `state.inLibrary == true`.
5. Côté API : `getMangaDetails` retourne déjà `userRating` via `MangaQuickViewDto.fromLibrary` mais pas dans `MangaDetailsDto`. Ajouter au mapping.

Estimation : ~1-2 h.
