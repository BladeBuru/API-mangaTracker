# VERSIONNING — mangas

| Version | Date | Artefact/Composant | Changement | Auteur |
|---------|------|--------------------|------------|--------|
| 0.1.0 | 2026-06-04 | spec-technique.md | Création initiale par rétro-ingénierie | @retro-documenter |
| 0.2.0 | 2026-08-26 | description-translation.service, catalog-sync.service, catalog-sync.mapper, genre.utils, mu-rate-limit.exception, manga-translation.entity, catalog-sync-state.entity, deepl.provider, gtx.provider | feat/recos-chapitres-traductions : traductions serveur (DescriptionTranslationService, providers DeepL/gtx, table manga_translation), catalogue nightly (CatalogSyncService, cron 03:30, curseur de reprise, table catalog_sync_state) + corrections revue adversariale (d8641f4) : lots upsert null-safe, statut partial sur erreur DB, MuRateLimitException → [] gracieux, SWR hash mismatch + negative-cache 5 min | Claude |
