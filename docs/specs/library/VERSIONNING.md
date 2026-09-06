# VERSIONNING — library

| Version | Date | Artefact/Composant | Changement | Auteur |
|---------|------|--------------------|------------|--------|
| 0.1.0 | 2026-06-04 | spec-technique.md | Création initiale par rétro-ingénierie | @retro-documenter |
| 0.2.0 | 2026-07-20 | library.service, chapter-log.service, chapter-report.service, library.controller, chapter-report.controller | Chantier A : signalement chapitres (`POST /library/:muId/report-chapters`), table `manga_chapter_report`, backfill transactionnel journal, cap 406 sur total effectif, GREATEST monotone `total_chapters` | Claude |
| 0.3.0 | 2026-08-26 | user-throttler.guard, chapter-log.service, library.service | Corrections revue adversariale (d8641f4) : throttle par userId 10/h sur report-chapters (vs IP inefficace derrière NPMplus), dédup 10 min met à jour scrollPosition/isBonus au lieu d'ignorer, commentaire race backfill FOR UPDATE documenté | Claude |
| 0.4.0 | 2026-09-06 | reading-position.controller, reading-position.service, user-scoped-throttler.guard, library.service, user-manga.entity, manga-quick-view.dto | Reprise de lecture inter-appareils : `PUT /library/reading-position` + `GET /library/:muId/reading-position`, colonnes `current_chapter` / `current_position_percent` / `current_position_updated_at` (migration `1788393600000`), invalidation de la position dans l'UPDATE de `PUT /library/chapter`, champs optionnels sur `GET /library/all`, throttle nominatif 60/min | Claude |
