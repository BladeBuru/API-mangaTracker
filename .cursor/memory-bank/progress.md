# Progrès — Manga Tracker API

> Dernière mise à jour : Mars 2026

---

## ✅ Fonctionnalités complétées

### Authentification (`user/auth`)
- ✅ Register (création de compte + hashage bcrypt)
- ✅ Login (validation + génération AccessToken + RefreshToken)
- ✅ Refresh token (renouvellement accessToken)
- ✅ Guards JWT (`AuthGuard('jwt')`, `AuthGuard('jwt-refresh')`)
- ✅ Stratégies Passport (`AccessTokenStrategy`, `RefreshTokenStrategy`)

### Utilisateurs (`user`)
- ✅ Récupération du profil utilisateur
- ✅ Mise à jour du nom
- ✅ Changement de mot de passe (sécurisé bcrypt)
- ✅ Suppression de compte

### Mangas (`mangas`)
- ✅ Récupération des mangas populaires / tendances / nouveaux
- ✅ Récupération des détails d'un manga (via MangaUpdates API)
- ✅ Recherche de mangas
- ✅ Service de synchronisation (`SyncMangaService`)
- ✅ Service de mise à jour (`UpdateMangaService`)
- ✅ Entités `MangaEntity` + `UserMangaEntity`

### Bibliothèque (`library`)
- ✅ Ajouter un manga à la bibliothèque
- ✅ Supprimer un manga de la bibliothèque
- ✅ Lister la bibliothèque de l'utilisateur
- ✅ Récupérer un manga spécifique de la bibliothèque
- ✅ Mettre à jour le statut de lecture (`ReadingStatus`)
- ✅ Mettre à jour la progression (chapitres lus)
- ✅ Mettre à jour les liens personnalisés

### Infrastructure
- ✅ PostgreSQL + TypeORM configuré
- ✅ Swagger documentant tous les endpoints
- ✅ Docker Compose pour l'environnement local (`toolbox/docker-compose.yml`)
- ✅ Variables d'environnement via `@nestjs/config`

---

## 🔴 À implémenter

### Court terme
- 🔴 Endpoint proxy pour les images MangaUpdates (éviter les restrictions CORS)
- 🔴 Traduction des champs manga (titre, description) selon la langue utilisateur
- 🔴 Historique de recherche utilisateur
- 🔴 Endpoint Google OAuth2
- 🔴 Confirmation e-mail

### Moyen terme
- 🔴 Système de notifications (nouvelles sorties de chapitres)
- 🔴 Cache Redis + BullMQ
- 🔴 Notes et avis utilisateurs (système de notation)
- 🔴 Statistiques utilisateur (chapitres lus, temps de lecture, streak)
- 🔴 Calendrier des sorties

### Long terme
- 🔴 Recommandations personnalisées (LightFM via FastAPI)
- 🔴 Espace communautaire (forum, discussions)
- 🔴 CI/CD GitHub Actions

---

## 🐛 Problèmes connus

- Aucun problème critique connu actuellement

---

## 📈 Progression globale

**≈ 50% du MVP** — Socle technique solide (auth, mangas, bibliothèque).
Prochaines priorités : traduction champs, proxy images, notifications, cache Redis.
