# VERSIONNING — recommendations

| Version | Date | Artefact/Composant | Changement | Auteur |
|---------|------|--------------------|------------|--------|
| 0.1.0 | 2026-06-04 | spec-technique.md | Création initiale par rétro-ingénierie | @retro-documenter |
| 0.2.0 | 2026-07-20 | recommendation.service, recommendation.module, reco-cache.service | feat/recos-chapitres-traductions : CatalogCandidateService (top-up catalogue genres, pool < 150), fetchAndScoreBlocking (délai inter-batch, MuRateLimitException), suppression relaxIfPoolTooSmall (no-op prouvé), MAX_RECOS_PER_SOURCE 30→40 | Claude |
| 0.3.0 | 2026-08-26 | genre-section.service, scored-entry.interface, recommendation.service | fix/recos-by-genre-dedup : GenreSectionService extrait (dédup mu_id, exclusivité inter-sections, complément catalogue par section, 1 requête max par section, pas de N+1) + correction spec (constantes à jour, swagger note corrigée) | Claude |
| 0.4.0 | 2026-09-05 | type-profile.ts, recommendation.service, sleeper-hits.service, recommendation-dto-builder.service, genre-section.service, catalog-candidate.service, recommendation.module | feat/manga-type-recos-home : recommandations sensibles au type (profil pondéré, sélection au prorata `interleaveByTypeMix` sur liste plate / by-genre / sleepers, candidats catalogue par bucket de type, NULL = inconnu pénalisé) ; découpage de recommendation.service.ts (889 → 526 lignes) en SleeperHitsService + RecommendationDtoBuilderService | Claude |
