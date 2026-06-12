# RETRO-001 — Sessions multi-appareils avec rotation create-before-delete

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
| Q1 — Coût de revert > 1j ? | OUI — supprimer les sessions persistées en base impliquerait de refactorer `auth.service`, `auth.helper`, `user-session.entity`, les deux stratégies JWT, `RefreshTokenGuard`, et tous les modules qui appellent `revokeAllSessionsForUser` ou `logoutAll` (GDPR, email reset). Refactoring transverse > 1 journée. |
| Q2 — Non-déductible du code ? | OUI — `package.json` ne révèle pas que les sessions sont persistées en base avec un UUID distinct par appareil, ni que l'ordre de rotation est create-before-delete plutôt que delete-before-create. L'intention (robustesse en cas d'échec de création) est documentée en commentaire dans `auth.service.ts` mais n'est pas déductible des dépendances. |
| Q3 — Impact transverse (≥ 2 specs) ? | OUI — la stratégie de session concerne la spec `auth` (rotation, login, logout), la spec `gdpr` (export et suppression de sessions utilisateur), la spec `email` (révocation de toutes les sessions après reset password), et toute spec de module protégé par `@UseGuards(AuthGuard('jwt'))`. |
| Q4 — Casse un invariant si ignoré ? | OUI — inverser l'ordre (supprimer l'ancienne avant de créer la nouvelle) déconnecterait définitivement l'utilisateur si `createSession` échoue (DB indisponible, contrainte violée) : son refresh token actuel pointerait une session supprimée, aucun nouveau token ne lui serait retourné. |

> Validé contre la politique `.claude/rules/06-adr-policy.md`.

---

## Contexte

L'application mobile Flutter cible Android et iOS, potentiellement plusieurs appareils simultanément par utilisateur. Une architecture JWT stateless pour l'access token (court-vécu) couplée à un refresh token long-vécu persisté en base permet de révoquer explicitement les sessions d'un appareil sans invalider les autres.

La décision de persister les sessions en base (plutôt qu'un refresh token opaque sans état) est la condition nécessaire pour que la révocation ciblée et la révocation globale soient possibles.

---

## Décision identifiée

1. **Chaque connexion réussie crée une entrée `user_session`** dans la table `user_session` avec un UUID généré via `crypto.randomUUID()`, associé à un `deviceInfo` optionnel fourni par le client.
2. **Le refresh token encode le `sessionId`** dans son payload JWT (`{ id: userId, sessionId }`). La validation du refresh token nécessite donc que la session correspondante existe en base.
3. **Rotation create-before-delete** : lors d'un refresh, la nouvelle session est créée et son ID encodé dans le nouveau token AVANT la suppression de l'ancienne. Si la création de la nouvelle session échoue, l'ancienne reste valide. Si la suppression de l'ancienne échoue après succès de la création, l'échec est loggé en `warn` mais non bloquant (session orpheline nettoyée par job de purge).
4. **`lastLoginAt` n'est mis à jour qu'après `createSession`** pour ne pas marquer l'utilisateur comme connecté si aucune session ne lui est associée.
5. **Cascade `onDelete: 'CASCADE'`** sur la clé étrangère `user_session.user_id` : la suppression du compte utilisateur supprime toutes ses sessions automatiquement.

---

## Conséquences observées

### Positives

- Révocation ciblée par appareil (`POST /auth/logout`) sans impact sur les autres sessions de l'utilisateur.
- Révocation globale (`POST /auth/logout-all`, `revokeAllSessionsForUser`) pour les flows de sécurité (reset password, compromission suspectée).
- Robustesse du refresh : en cas d'échec de création de la nouvelle session, l'ancien refresh token reste utilisable. L'utilisateur peut retenter sans être déconnecté.
- Audit possible des appareils connectés (via `deviceInfo` + `createdAt`).

### Négatives / Dette

- **Pas de cap sur le nombre de sessions** : un utilisateur peut accumuler un nombre illimité d'entrées `user_session` si les anciennes ne sont pas nettoyées (pas de logout explicite ou de TTL sur les sessions).
- **Pas de TTL natif sur `user_session`** : l'expiration du refresh token (côté JWT) n'est pas reflétée en base. Les sessions orphelines (refresh token expiré mais session non supprimée) restent en base jusqu'à un logout explicite ou une révocation globale.
- **Job de purge manquant** : aucun `@Cron` visible dans le module pour nettoyer les sessions dont le refresh token est expiré.

---

## Recommandation

Garder — la persistance des sessions et la rotation create-before-delete sont les bons choix pour une app multi-appareils avec révocation explicite.

Ajouter un job de purge périodique des sessions dont `createdAt + JWT_REFRESH_EXPIRATION < now()` pour éviter l'accumulation de sessions orphelines.
