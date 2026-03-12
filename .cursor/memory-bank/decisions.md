# Décisions Architecturales — Manga Tracker API

**Dernière mise à jour :** Mars 2026

---

## Décisions Prises

### Architecture en couches Controller/Service
**Décision** : Séparation stricte Controller / Service, pas de Repository séparé (TypeORM injecté directement dans les services)
**Raison** : Simplicité pour ce projet de taille moyenne, TypeORM avec `Repository<Entity>` suffit sans couche supplémentaire
**Impact** : Controller < 200 lignes, Service < 400 lignes — découpage en services spécialisés si besoin (ex: `SyncMangaService`, `UpdateMangaService`)
**Date** : Conception initiale

---

### Base de données : PostgreSQL + TypeORM
**Décision** : PostgreSQL avec TypeORM (pas Prisma, pas MongoDB)
**Raison** : Données relationnelles (users → library → mangas), besoin de transactions, écosystème NestJS mature
**Impact** : Entités TypeORM avec décorateurs, migrations TypeORM, UUID pour toutes les PKs
**Date** : Conception initiale

---

### Authentification : JWT double token (Access + Refresh)
**Décision** : AccessToken court terme + RefreshToken long terme via Passport
**Raison** : Sécurité (réduire la fenêtre d'exposition des tokens), expérience utilisateur (pas de re-login fréquent)
**Impact** :
- Endpoint `POST /auth/refresh` pour renouveler l'accessToken
- Stratégies Passport séparées : `jwt` (access) et `jwt-refresh` (refresh)
- Côté Flutter : `HttpService` gère le refresh automatiquement
**Date** : Conception initiale

---

### Source des données mangas : MangaUpdates API
**Décision** : Synchronisation depuis l'API MangaUpdates, pas de scraping
**Raison** : API officielle disponible, données fiables et structurées
**Impact** : `SyncMangaService` pour synchroniser, `UpdateMangaService` pour les mises à jour, entité `MangaEntity` comme cache local
**Date** : Conception initiale

---

### Validation : class-validator + ValidationPipe (whitelist: true)
**Décision** : Validation stricte avec `whitelist: true` et `forbidNonWhitelisted: true`
**Raison** : Sécurité (rejet des champs non déclarés), cohérence des données
**Impact** : Tous les DTOs doivent déclarer explicitement chaque champ autorisé
**Date** : Conception initiale

---

## Décisions Futures à Prendre

_(À compléter lors de nouvelles décisions importantes)_

| Sujet | Contexte | Deadline | Options |
|-------|----------|----------|---------|
| Cache Redis | Réduire les appels MangaUpdates API | v0.2 | Redis + BullMQ vs simple TTL en mémoire |
| Notifications push | Alertes nouvelles sorties | v0.3 | Firebase FCM vs OneSignal vs auto-hébergé |
| Google OAuth2 | Connexion simplifiée | v0.3 | Passport Google vs implémentation manuelle |
| Proxy images | Éviter les restrictions CORS MangaUpdates | Court terme | Endpoint proxy NestJS vs CDN |

---

## Alternatives Considérées

| Décision | Alternative rejetée | Raison du rejet |
|----------|-------------------|-----------------|
| TypeORM | Prisma | Écosystème NestJS plus mature avec TypeORM au moment du choix |
| PostgreSQL | MongoDB | Données relationnelles (users/library/mangas) inadaptées à MongoDB |
| JWT maison | Auth0 / Firebase Auth | Complexité inutile pour un projet solo, coût, dépendance externe |
| class-validator | Zod | class-validator natif NestJS, meilleure intégration avec Swagger |
