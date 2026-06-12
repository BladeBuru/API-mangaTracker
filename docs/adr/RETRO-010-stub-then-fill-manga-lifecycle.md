# RETRO-010 — Cycle de vie stub-then-fill pour l'entité Manga

| Champ      | Valeur              |
|------------|---------------------|
| Statut     | Documenté (rétro)   |
| Date       | 2026-06-04          |
| Source     | Rétro-ingénierie    |
| Features   | mangas              |

## Justification (politique ADR v2.3.0)

| Champ | Valeur |
|-------|--------|
| Catégorie | DATA-MODEL |
| Q1 — Coût de revert > 1j ? | OUI — Supprimer ce pattern (ex. forcer un détail MU complet avant toute insertion) nécessiterait de modifier `saveRecommendations`, `CoverProxyService`, `UpdateMangaService.checkIfMangaArrayInfoIsOutdated`, les migrations qui ont rendu `small_cover_url` / `medium_cover_url` nullable, et tous les callers qui tolèrent les champs nullable. Refactoring transverse sur au moins 4 fichiers + 1 migration. |
| Q2 — Non-déductible du code ? | OUI — Le fait que `nullable: true` sur `small_cover_url` / `medium_cover_url` soit une décision architecturale délibérée (cycle de vie à deux états) et non un défaut de validation ne se lit pas dans `package.json` ni dans `tsconfig.json`. La migration `1746230800000` et le commentaire `@Column({ nullable: true })` dans `manga.entity.ts` portent l'intention, mais un dev ne lisant que les configs ne verra pas la règle. |
| Q3 — Impact transverse (≥ 2 specs) ? | OUI — La contrainte impacte : spec `mangas` (insertion stubs via `saveRecommendations`, fetch lazy via `getMangaDetails`), spec `library` (UpdateMangaService est exporté et utilisé par LibraryService pour détecter les mangas outdated), spec future `recommendations` (les recommandations communautaires et MU reposent sur des stubs pré-insérés). |
| Q4 — Casse un invariant si ignoré ? | OUI — Un dev qui ne connaît pas ce pattern pourrait ajouter une contrainte `NOT NULL` sur `small_cover_url` via une migration (logique car « une cover devrait toujours exister »), cassant silencieusement l'insertion de stubs par `saveRecommendations`. Résultat : les recommandations seraient perdues sans erreur visible (la contrainte rejetterait l'INSERT silencieusement ou avec une erreur DB avalée par le `catch`). |

> Validé contre la politique `.claude/rules/06-adr-policy.md`.

---

## Contexte

L'API MangaUpdates expose des recommandations pour chaque manga (jusqu'à 5 par manga). Ces recommandations référencent des manga IDs qui peuvent ne pas encore être présents dans la BDD locale. Pour pouvoir les stocker en `manga_recommendation` (qui référence un `manga.mu_id`), il faut que le manga existe dans la table `manga`.

La migration `1746230800000` a rendu nullable les colonnes `small_cover_url` et `medium_cover_url` précisément pour permettre cette insertion sans détail complet.

---

## Décision identifiée

Un manga peut exister dans la table `manga` sous deux états distincts :

**État stub** : inséré automatiquement lors de `saveRecommendations` avec uniquement `mu_id` et `title` (les covers peuvent être pré-remplies si MU les fournit dans `series_image`). Tous les autres champs (`rating`, `year`, `completed`, `genres`) restent à leur valeur par défaut ou NULL. L'insertion utilise `ON CONFLICT (mu_id) DO NOTHING` — un stub n'écrase jamais un manga complet.

**État complet** : rempli lors du premier appel à `getMangaDetails(muId)` (déclenché par `GET /mangas/:id` ou le background refresh). Tous les champs sont mis à jour via `mangaRepository.update({ mu_id }, { ... })`.

Le code downstream (CoverProxyService, UpdateMangaService, MangaQuickViewDto) doit tolérer les champs nullable — notamment `medium_cover_url` qui peut être NULL sur un stub.

---

## Conséquences observées

### Positives

- Les recommandations sont stockées immédiatement sans bloquer sur un fetch MU synchrone pour chaque manga recommandé, ce qui éviterait des timeout ou des latences lors de la consultation d'une fiche.
- La première ouverture d'une fiche de recommandation par un utilisateur déclenche le fill complet — le coût est payé au bon moment (à la demande).
- `ON CONFLICT DO NOTHING` garantit que les données existantes ne sont jamais dégradées par une insertion de stub.

### Négatives / Dette

- Toute évolution du schéma de la table `manga` (ajout d'une contrainte NOT NULL, d'une valeur DEFAULT requise) doit tenir compte de l'existence des stubs et ne pas casser leur insertion.
- Le code downstream doit systématiquement gérer le cas `medium_cover_url = null`, ce qui crée une obligation implicite non documentée localement dans chaque service/DTO.
- Le rétro-fix dans `saveRecommendations` (mise à jour des stubs sans cover avec `WHERE medium_cover_url IS NULL`) ajoute une complexité de maintenance : deux passes SQL par appel de sauvegarde de recommandations.

---

## Recommandation

Garder — le pattern est bien établi et documenté dans les commentaires du code. Renforcer la documentation dans `manga.entity.ts` avec une section explicitant les deux états de vie et la règle d'invariant sur les constraints de schéma.
