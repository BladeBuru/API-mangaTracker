# Politique de confidentialité — Manga Tracker

**Version :** 1.0
**Date d'entrée en vigueur :** À compléter avant publication

---

> ⚠️ **Note importante** : ce document est un modèle de base conforme au RGPD.
> Avant publication, faites-le **valider par un juriste**. L'éditeur de
> Manga Tracker est seul responsable de la conformité finale.

---

## 1. Identité du responsable du traitement

- **Nom commercial** : Manga Tracker
- **Éditeur** : _[Nom / Raison sociale à compléter]_
- **Adresse** : _[Adresse postale]_
- **Email de contact** : _[contact@manga-tracker.example]_
- **Délégué à la protection des données (DPO)** : _[email DPO si applicable]_

## 2. Données collectées

Manga Tracker collecte les données suivantes :

### 2.1 Lors de l'inscription
- **Email** (identifiant de connexion)
- **Mot de passe** (stocké uniquement sous forme de hash bcrypt — jamais en clair)
- **Nom d'utilisateur** (optionnel)

### 2.2 Si connexion via Google OAuth
- **Email Google**, **nom**, **identifiant Google unique** (pour la liaison de compte)
- Aucun autre attribut Google n'est stocké.

### 2.3 Lors de l'utilisation
- **Bibliothèque de mangas** : la liste des mangas que vous suivez, leur statut de lecture, votre note personnelle (1–10), votre progression en chapitres, vos liens personnalisés
- **Préférences** : langue d'affichage, thème (clair/sombre)
- **Sessions actives** : token de rafraîchissement chiffré, date/IP de dernière connexion (pour la sécurité)
- **Logs techniques** : messages d'erreur anonymisés (pas d'email ni de contenu utilisateur)

### 2.4 Données NON collectées
- Aucune donnée bancaire (Manga Tracker est gratuit, sans paiement)
- Aucun identifiant biométrique (le déverrouillage par empreinte/Face ID s'opère **localement** sur l'appareil — aucune empreinte n'est envoyée à nos serveurs)
- Aucun tracker publicitaire tiers
- Aucune géolocalisation précise

## 3. Finalités du traitement

| Finalité | Base légale (RGPD) |
|---------|-------------------|
| Authentification et gestion de compte | Exécution d'un contrat (article 6.1.b) |
| Stockage de votre bibliothèque manga | Exécution d'un contrat |
| Recommandations personnalisées | Intérêt légitime (article 6.1.f) — utilisation de votre bibliothèque pour générer des suggestions |
| Notes communautaires agrégées | Intérêt légitime — données anonymisées (moyenne et compte uniquement) |
| Sécurité (rate-limit, détection d'abus) | Intérêt légitime |
| Statistiques internes anonymisées | Intérêt légitime |

## 4. Sous-traitants et destinataires

Vos données peuvent être transmises aux sous-traitants suivants :

| Sous-traitant | Rôle | Données concernées | Localisation |
|---------------|------|---------------------|--------------|
| MangaUpdates (api.mangaupdates.com) | Source des données manga (uniquement requêtes sur les titres, **pas vos données utilisateur**) | Aucune donnée personnelle | États-Unis |
| _[Hébergeur — ex: OVH, Scaleway, AWS]_ | Hébergement de la base de données | Toutes vos données | _[À compléter]_ |
| Google (si OAuth utilisé) | Authentification | Email + identifiant Google | États-Unis (DPF certifié) |

**Aucune donnée n'est vendue à des tiers** (pas d'usage publicitaire ou marketing).

## 5. Durée de conservation

| Donnée | Durée |
|--------|-------|
| Compte actif | Toute la durée de votre utilisation |
| Compte supprimé | Suppression effective sous 30 jours après votre demande (purge des sauvegardes) |
| Logs techniques | 90 jours maximum |
| Tokens de session révoqués | 7 jours (le temps de la rotation) |

## 6. Vos droits

Conformément au RGPD, vous disposez des droits suivants. Pour les exercer, utilisez l'onglet **« Mes données »** dans l'application ou contactez-nous à _[contact@manga-tracker.example]_.

### Droit d'accès (article 15)
Vous pouvez consulter à tout moment l'ensemble de vos données via l'endpoint `GET /users/data` ou l'export complet `GET /users/data-export`.

### Droit de rectification (article 16)
Modifiez votre nom ou mot de passe directement dans l'application.

### Droit à l'effacement / « droit à l'oubli » (article 17)
Le bouton **« Supprimer mon compte »** dans l'app supprime définitivement toutes vos données (sous 30 jours pour les sauvegardes).

### Droit à la portabilité (article 20)
L'endpoint `GET /users/data-export` retourne l'intégralité de vos données dans un format JSON structuré et lisible.

### Droit d'opposition (article 21)
Vous pouvez vous opposer à tout traitement basé sur l'intérêt légitime (recommandations communautaires) en supprimant votre compte.

### Droit de retirer son consentement
Si un consentement spécifique a été donné, vous pouvez le retirer à tout moment dans **Paramètres → Confidentialité**.

### Droit de réclamation
Si vous estimez que vos droits ne sont pas respectés, vous pouvez introduire une réclamation auprès de la CNIL (www.cnil.fr) ou de votre autorité de protection des données nationale.

## 7. Sécurité

Nous mettons en œuvre des mesures techniques et organisationnelles raisonnables :

- Chiffrement TLS pour toutes les communications client/serveur
- Mots de passe hashés avec bcrypt (saltRounds ≥ 10)
- Tokens JWT à courte durée (15 min) + refresh tokens à 7 jours rotatifs
- Stockage sécurisé des tokens côté client (`flutter_secure_storage` → Keystore Android / Keychain iOS / WebCrypto)
- Headers de sécurité HTTP (helmet) sur l'API
- Rate-limiting sur les endpoints d'authentification
- Sauvegardes chiffrées de la base de données
- Accès aux serveurs limité à un nombre restreint d'administrateurs identifiés

Aucun système n'est infaillible. En cas de violation de données affectant vos droits, **nous nous engageons à vous notifier dans les 72 heures** conformément à l'article 34 du RGPD.

## 8. Cookies et stockage local

L'application Manga Tracker n'utilise **aucun cookie de tracking**.

Le stockage local sur votre appareil contient uniquement :
- Les tokens JWT de votre session (stockés de manière chiffrée)
- Le cache des mangas pour le mode hors ligne
- Vos préférences (langue, thème)

Vous pouvez supprimer ces données via **Paramètres → Réinitialiser** ou en désinstallant l'application.

## 9. Mineurs

Manga Tracker est ouvert à partir de **13 ans**. Les utilisateurs entre 13 et 15 ans en France doivent obtenir l'autorisation de leurs parents (article 8 du RGPD).

Le contenu mature (NSFW) est filtré automatiquement par défaut.

## 10. Modifications de cette politique

Cette politique peut être amendée. Les changements significatifs vous seront notifiés via l'application au moins **30 jours avant** leur entrée en vigueur. La version applicable est toujours la plus récente publiée à _[URL de la politique]_.

## 11. Contact

Pour toute question relative à cette politique de confidentialité ou à l'exercice de vos droits :

**Email** : _[privacy@manga-tracker.example]_
**Adresse** : _[Adresse postale complète]_
