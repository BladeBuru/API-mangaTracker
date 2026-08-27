# Décisions Architecturales — Manga Tracker API

**Dernière mise à jour :** Juillet 2026

---

## Décisions Prises

### Architecture en couches Controller/Service
**Décision** : Séparation stricte Controller / Service, pas de Repository séparé (TypeORM injecté directement dans les services).
**Raison** : Simplicité pour ce projet de taille moyenne, TypeORM `Repository<Entity>` suffit sans couche supplémentaire.
**Impact** : Controller < 200 lignes, Service < 400 lignes — découpage en services spécialisés si besoin (`SyncMangaService`, `UpdateMangaService`).
**Date** : Conception initiale

---

### Base de données : PostgreSQL + TypeORM
**Décision** : PostgreSQL avec TypeORM (pas Prisma, pas MongoDB).
**Raison** : Données relationnelles (users → library → mangas), besoin de transactions, écosystème NestJS mature.
**Impact** : Entités TypeORM avec décorateurs, migrations TypeORM, UUID pour toutes les PKs.
**Date** : Conception initiale

---

### Authentification : JWT double token (Access + Refresh)
**Décision** : AccessToken court terme + RefreshToken long terme via Passport.
**Raison** : Sécurité (réduire fenêtre d'exposition), expérience utilisateur (pas de re-login fréquent).
**Impact** :
- Endpoint `POST /auth/refresh`
- Stratégies Passport séparées : `jwt` (access) et `jwt-refresh` (refresh)
- Côté Flutter : `HttpService` gère le refresh automatiquement
**Date** : Conception initiale

---

### Source des données mangas : MangaUpdates API
**Décision** : Sync depuis l'API MangaUpdates, pas de scraping.
**Raison** : API officielle, données fiables et structurées.
**Impact** : `SyncMangaService`, `UpdateMangaService`, `MangaEntity` comme cache local.
**Date** : Conception initiale

---

### Validation : class-validator + ValidationPipe (whitelist: true)
**Décision** : Validation stricte avec `whitelist: true` et `forbidNonWhitelisted: true`.
**Raison** : Sécurité (rejet des champs non déclarés), cohérence des données.
**Impact** : Tous les DTOs déclarent explicitement chaque champ autorisé.
**Date** : Conception initiale

---

### Sécurité non-négociable (ajouté évolution)
**Décision** :
- `synchronize: false` en production (jamais auto-sync)
- Migrations TypeORM obligatoires
- Secrets jamais versionnés (`*.env` gitignored, sauf `template.env`)
- `helmet` + `@nestjs/throttler` installés et configurés sur `main.ts`
- CORS avec whitelist explicite par environnement
- Throttle renforcé sur `/auth/login`, `/auth/register`, `/auth/refresh`

**Raison** : Endurcissement avant exposition publique de l'API. L'API sert le mobile (Android, iOS, Web à venir) — surface d'attaque qui s'élargit.
**Impact** : Refactor `main.ts`, ajout dépendances, migrations TypeORM à créer rétroactivement, retrait des secrets versionnés (rotation des clés concernées).
**Date** : 2026-05 (évolution sécurité)

---

### CORS multi-clients (ajouté évolution)
**Décision** : CORS avec whitelist par env, prête pour mobile + web.
**Raison** : Le front Flutter cible Android (actuel), iOS et Web à venir. La whitelist doit anticiper le domaine web futur.
**Impact** : Variable `CORS_ORIGINS` (séparée par virgules) consommée dans `main.ts`. Mise à jour de la whitelist quand le domaine web sera décidé.
**Date** : 2026-05 (évolution sécurité)

---

### total_chapters : écriture GREATEST inconditionnelle (anti-régression)
**Décision** : Toute écriture de `manga.total_chapters` depuis MangaUpdates passe par `GREATEST(total_chapters, :newTotal)` — `MangasService.getMangaDetails`, `LibraryService.checkManga` (refresh 6h) et `ChapterReportService.consolidate` — **y compris quand MU annonce `completed = true` avec un total plus bas**.
**Raison** :
- Le total MU est extrait par regex sur le champ `status` → peu fiable (baisses fantômes constatées).
- `sync-manga.service.ts` faisait déjà `Math.max` : on généralise l'invariant au lieu d'avoir deux comportements.
- Un user avec `user_read_chapters = 90` prouve que le total réel ≥ 90 — une régression re-bloquerait sa progression (bug du cap 406).
- Le chantier « signalement chapitres » (`manga_chapter_report`) repose sur des totaux **monotones croissants** pour que consolidation et refresh 6h convergent sans lock.
**Impact** : une baisse légitime côté MU (correction éditoriale, très rare) ne redescend jamais automatiquement → correction manuelle en BDD assumée. `completed` reste écrasé par MU à chaque refresh (seul `total_chapters` est monotone).
**Date** : 2026-07 (chantiers signalement chapitres + historique de lecture)

---

## Décisions Futures à Prendre

| Sujet | Contexte | Deadline | Options |
|-------|----------|----------|---------|
| Cache Redis | Réduire les appels MangaUpdates API | v0.2 | Redis + BullMQ vs simple TTL en mémoire |
| Notifications push | Alertes nouvelles sorties | v0.3 | Firebase FCM vs OneSignal vs auto-hébergé |
| Google OAuth2 | Connexion simplifiée | v0.3 | Passport Google vs implémentation manuelle |
| Proxy images | Éviter les restrictions CORS MangaUpdates | Court terme | Endpoint proxy NestJS vs CDN |
| Versioning API | Si rupture de contrat future | v1.0 | Préfixe `/v1/` dès maintenant ou au premier breaking change |
| Rotation secrets JWT | Sécurité long terme | v1.0 | Mécanisme `kid` header vs rotation planifiée |

---

## Alternatives Considérées

| Décision | Alternative rejetée | Raison du rejet |
|----------|-------------------|-----------------|
| TypeORM | Prisma | Écosystème NestJS plus mature avec TypeORM au moment du choix |
| PostgreSQL | MongoDB | Données relationnelles inadaptées à MongoDB |
| JWT maison | Auth0 / Firebase Auth | Complexité inutile pour un projet solo, coût, dépendance externe |
| class-validator | Zod | class-validator natif NestJS, meilleure intégration avec Swagger |
