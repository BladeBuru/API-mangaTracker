# RETRO-003 — Liaison silencieuse de compte Google par email

| Champ      | Valeur              |
|------------|---------------------|
| Statut     | Documenté (rétro)   |
| Date       | 2026-06-04          |
| Source     | Rétro-ingénierie    |
| Features   | auth                |

## Justification (politique ADR v2.3.0)

| Champ | Valeur |
|-------|--------|
| Catégorie | AUTH |
| Q1 — Coût de revert > 1j ? | OUI — changer la stratégie de fusion (ex: rejeter la liaison et forcer l'utilisateur à choisir, ou créer un compte séparé) impliquerait une migration des `googleId` déjà liés aux comptes locaux existants, une modification de `findOrCreateGoogleUser`, une mise à jour des flows RGPD (export/delete d'un compte lié vs deux comptes séparés), et potentiellement une notification utilisateur (breaking change UX). > 1 journée. |
| Q2 — Non-déductible du code ? | OUI — `package.json` ne révèle pas la stratégie de fusion de comptes par email. La décision de ne pas modifier `authProvider` lors de la liaison (permettre les deux méthodes de connexion en parallèle) est une intention architecturale qui ne se déduit pas des dépendances. |
| Q3 — Impact transverse (≥ 2 specs) ? | OUI — affecte la spec `auth` (connexion locale + Google sur le même compte), la spec `gdpr` (l'export et la suppression d'un compte lié doivent gérer les deux providers), et toute spec affichant l'identité ou le profil (un compte peut avoir `authProvider=LOCAL` mais un `googleId` non null). |
| Q4 — Casse un invariant si ignoré ? | OUI — ignorer cette règle et créer un compte Google séparé pour un email déjà local produirait des comptes dupliqués avec des bibliothèques manga distinctes : l'utilisateur perdrait ses données de lecture, la `DELETE CASCADE` RGPD ne trouverait qu'un des deux comptes, et `revokeAllSessionsForUser` n'invaliderait que les sessions d'un seul. |

> Validé contre la politique `.claude/rules/06-adr-policy.md`.

---

## Contexte

Un utilisateur peut s'être inscrit localement (email + mot de passe) avant que la connexion Google soit disponible, ou peut avoir un compte Google avec la même adresse email. Sans stratégie de liaison, la première connexion Google créerait un deuxième compte avec une bibliothèque vide, conduisant à une expérience dégradée et à des problèmes de conformité RGPD (deux profils pour la même personne).

---

## Décision identifiée

Dans `AuthService.findOrCreateGoogleUser`, la logique de lookup est la suivante :

1. **Lookup par `googleId`** : si un utilisateur avec ce `googleId` existe, il est retourné directement.
2. **Lookup par email** : si aucun compte avec ce `googleId` n'existe mais qu'un compte avec cet email existe (compte local), le `googleId` est ajouté au compte existant via `repository.save(user)`. **L'`authProvider` n'est pas modifié** — il reste `LOCAL`, ce qui signifie que l'utilisateur peut continuer à se connecter avec email/mot de passe ET avec Google.
3. **Création** : si aucun compte n'existe ni par `googleId` ni par email, un nouveau compte est créé avec `authProvider=GOOGLE` et `password=null`.

La liaison est **silencieuse** : aucune confirmation n'est demandée à l'utilisateur, aucune notification n'est envoyée.

---

## Conséquences observées

### Positives

- Pas de comptes dupliqués : un email = un compte, quelle que soit la méthode de connexion utilisée.
- Continuité de la bibliothèque de lecture : l'utilisateur qui s'était inscrit localement retrouve ses données après la première connexion Google.
- Simplicité d'implémentation : pas de flow de confirmation, pas d'écran de fusion côté client.

### Négatives / Dette

- **Liaison sans consentement explicite** : un utilisateur qui a un compte local pourrait ne pas savoir que sa première connexion Google a lié les deux comptes. Si son adresse Google est compromise, l'attaquant peut accéder au compte local.
- **Vecteur d'attaque par substitution d'email** : si Google permettait (dans une configuration théorique) de changer l'email associé à un compte Google, la liaison automatique par email deviendrait un vecteur de prise de contrôle de compte.
- **`authProvider` ambiguë post-liaison** : un compte avec `authProvider=LOCAL` et un `googleId` non null n'a pas de provider canonique clairement défini côté API (pas de champ `linkedProviders[]`).

---

## Recommandation

Garder pour l'état actuel (app mobile avec une base utilisateurs limitée).

Envisager d'ajouter une notification email ou un consentement explicite côté client Flutter lors de la première liaison Google sur un compte local, pour améliorer la transparence (alignement RGPD article 13 — information sur les traitements).
