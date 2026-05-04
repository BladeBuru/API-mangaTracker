# Progrès — Manga Tracker API

> Dernière mise à jour : Mai 2026

---

## ✅ Fonctionnalités complétées

### Authentification (`user/auth`)
- ✅ Register (création de compte + hashage bcrypt)
- ✅ Login (validation + génération AccessToken + RefreshToken)
- ✅ Refresh token (renouvellement accessToken)
- ✅ Guards JWT (`AuthGuard('jwt')`, `AuthGuard('jwt-refresh')`)
- ✅ Stratégies Passport (`AccessTokenStrategy`, `RefreshTokenStrategy`)
- ✅ Google OAuth (intégré, voir auth.controller.ts)

### Utilisateurs (`user`)
- ✅ Récupération du profil utilisateur
- ✅ Mise à jour du nom
- ✅ Changement de mot de passe (bcrypt)
- ✅ Suppression de compte

### Mangas (`mangas`)
- ✅ Récupération populaires / tendances / nouveaux
- ✅ Récupération des détails (MangaUpdates API)
- ✅ Recherche
- ✅ `SyncMangaService`, `UpdateMangaService`
- ✅ Entités `MangaEntity` + `UserMangaEntity`

### Bibliothèque (`library`)
- ✅ Add / Remove / List / Get manga
- ✅ Update reading status
- ✅ Update chapter progress
- ✅ Update custom link

### Infrastructure
- ✅ PostgreSQL + TypeORM
- ✅ Swagger sur `/api`
- ✅ Docker Compose local (`toolbox/docker-compose.yml`)
- ✅ Variables d'environnement via `@nestjs/config`
- ✅ CI/CD GitHub Actions (`publish-image.yml`, `code-quality.yml`, `postman-tests.yml`)
- ✅ Image Docker multi-stage, user `node` non-root
- ✅ Sessions par device (UserSessionEntity, rotation refresh token)

---

## 🔴 À implémenter

### 🔒 Durcissement sécurité (PRIORITÉ HAUTE — voir known-issues.md)
- 🔴 **`synchronize: false`** en TypeORM + créer migrations rétroactives
- 🔴 **Retirer secrets versionnés** (`development.env`) + rotation des clés (JWT_KEY, JWT_REFRESH_SECRET, GOOGLE_CLIENT_SECRET) + ajouter `*.env` au `.gitignore` (sauf `template.env`)
- 🔴 **Installer `helmet`** + appliquer dans `main.ts`
- 🔴 **Installer `@nestjs/throttler`** + global + renforcé sur `/auth/login`, `/auth/register`, `/auth/refresh`
- 🔴 **CORS whitelist explicite** par env (`CORS_ORIGINS`) — préparer le front web futur
- 🔴 Scripts `migration:generate` / `migration:run` / `migration:revert` dans `package.json`
- 🔴 Migration:run dans la pipeline CI/CD avant déploiement

> Voir `.claude/skills/secure-deployment/SKILL.md` pour le workflow complet.

### Court terme
- 🔴 Endpoint proxy pour les images MangaUpdates (CORS)
- 🔴 Traduction des champs manga (titre, description) selon la langue utilisateur
- 🔴 Historique de recherche utilisateur
- 🔴 Confirmation e-mail

### Moyen terme
- 🔴 Système de notifications (nouvelles sorties)
- 🔴 Cache Redis + BullMQ
- 🔴 Notes et avis utilisateurs
- 🔴 Statistiques utilisateur (chapitres lus, temps, streak)
- 🔴 Calendrier des sorties
- 🔴 Tests unitaires étendus sur `auth/`

### Long terme
- 🔴 Recommandations personnalisées (LightFM via FastAPI)
- 🔴 Espace communautaire
- 🔴 Versioning API (`/v1/...`)
- 🔴 Rotation des secrets JWT (mécanisme `kid`)

---

## 🐛 Problèmes connus

Voir [.claude/memory-bank/known-issues.md](known-issues.md) — 5 problèmes actifs détectés à l'audit sécurité de mai 2026.

---

## 📈 Progression globale

**≈ 50% du MVP** — Socle technique solide (auth, mangas, bibliothèque). Sécurité production à durcir avant exposition publique.
Prochaines priorités : durcissement sécurité, traduction des champs, proxy images, notifications, cache Redis.
