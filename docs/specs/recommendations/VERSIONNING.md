# VERSIONNING — recommendations

| Version | Date | Artefact/Composant | Changement | Auteur |
|---------|------|--------------------|------------|--------|
| 0.1.0 | 2026-06-04 | spec-technique.md | Création initiale par rétro-ingénierie | @retro-documenter |
| 0.2.0 | 2026-07-20 | recommendation.service, recommendation.module, reco-cache.service | feat/recos-chapitres-traductions : CatalogCandidateService (top-up catalogue genres, pool < 150), fetchAndScoreBlocking (délai inter-batch, MuRateLimitException), suppression relaxIfPoolTooSmall (no-op prouvé), MAX_RECOS_PER_SOURCE 30→40 | Claude |
| 0.3.0 | 2026-08-26 | genre-section.service, scored-entry.interface, recommendation.service | fix/recos-by-genre-dedup : GenreSectionService extrait (dédup mu_id, exclusivité inter-sections, complément catalogue par section, 1 requête max par section, pas de N+1) + correction spec (constantes à jour, swagger note corrigée) | Claude |
