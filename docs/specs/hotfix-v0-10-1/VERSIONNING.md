# Versionning — hotfix-v0-10-1 (API)

| Version | Date | Type | Description | Commit |
|---------|------|------|-------------|--------|
| 0.1.0 | 2026-06-12 | feature | Implémentation complète : US-1 RGPD username + migration, US-2 cover stream, US-3 refresh 90d, US-4 cache recos + caps 40/80 | 4 commits sprint |
| 0.2.0 | 2026-06-19 | feature | friends: GET /friends/:id/library (403 si amitié non acceptée, RETRO-014) + FriendsModule importe UserManga | — |
| 0.2.0 | 2026-06-19 | feature | stats: Stats v2 — genreCounts top10, readingHistory 20 sessions (chapter_log, skips exclus), chaptersPerWeek 8 semaines (DATE_TRUNC) + StatsModule importe UserMangaChapterLog | — |
| 0.2.0 | 2026-06-19 | security | profile: PUT /user/password durci — currentPassword bcrypt, 400 CURRENT_PASSWORD_INVALID / SOCIAL_ACCOUNT_NO_PASSWORD, révocation sessions + TokenDto, Throttle 5/min | — |
| 0.2.0 | 2026-06-19 | security | sharing: stripEmailFormat sur MangaShareDto.senderUsername et ReadingGroupMemberDto.username/displayName (defense-in-depth RGPD) | — |
