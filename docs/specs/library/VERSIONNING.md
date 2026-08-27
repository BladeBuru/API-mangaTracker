# VERSIONNING — library

| Version | Date | Artefact/Composant | Changement | Auteur |
|---------|------|--------------------|------------|--------|
| 0.1.0 | 2026-06-04 | spec-technique.md | Création initiale par rétro-ingénierie | @retro-documenter |
| 0.2.0 | 2026-07-20 | library.service, chapter-log.service, chapter-report.service, library.controller, chapter-report.controller | Chantier A : signalement chapitres (`POST /library/:muId/report-chapters`), table `manga_chapter_report`, backfill transactionnel journal, cap 406 sur total effectif, GREATEST monotone `total_chapters` | Claude |
| 0.3.0 | 2026-08-26 | user-throttler.guard, chapter-log.service, library.service | Corrections revue adversariale (d8641f4) : throttle par userId 10/h sur report-chapters (vs IP inefficace derrière NPMplus), dédup 10 min met à jour scrollPosition/isBonus au lieu d'ignorer, commentaire race backfill FOR UPDATE documenté | Claude |
