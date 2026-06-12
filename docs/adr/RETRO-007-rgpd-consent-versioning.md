# RETRO-007 — RGPD — Versioning du consentement CGU + Privacy sur User

| Champ      | Valeur              |
|------------|---------------------|
| Statut     | Documenté (rétro)   |
| Date       | 2026-06-04          |
| Source     | Rétro-ingénierie    |
| Features   | gdpr                |

## Justification (politique ADR v2.3.0)

| Champ | Valeur |
|-------|--------|
| Catégorie | DATA-MODEL |
| Q1 — Coût de revert > 1j ? | OUI — remplacer le mécanisme (ex. table `user_consent` séparée, ou flag booléen simple) exigerait une migration de schéma sur `User`, une réécriture de `gdpr.service.ts`, et une adaptation du client Flutter ; impact transverse > 1 journée |
| Q2 — Non-déductible du code ? | OUI — le fait que la constante `CURRENT_TOS_VERSION` dans `gdpr.service.ts` soit le seul et unique déclencheur du re-consentement global n'est visible ni dans `package.json` ni dans les migrations ; un dev qui incrémente cette constante sans en comprendre la portée déclenche silencieusement une vague de re-consentement pour tous les utilisateurs |
| Q3 — Impact transverse (≥ 2 specs) ? | OUI — impacte `gdpr` (le mécanisme entier), `auth` (le flow login qui doit appeler `needsConsentRefresh` après authentification), et `profile` (les colonnes `acceptedTosAt/Version` sont sur l'entité `User` partagée) |
| Q4 — Casse un invariant si ignoré ? | OUI — un dev qui supprime ou n'alimente pas `acceptedTosVersion` efface la preuve légale du consentement (obligation RGPD article 7) ; un dev qui change `CURRENT_TOS_VERSION` sans avoir compris le mécanisme déclenche un re-consentement non planifié pour tous les utilisateurs existants |

> Validé contre la politique `.claude/rules/06-adr-policy.md`.

## Contexte

La conformité RGPD article 7 exige de pouvoir prouver qu'un utilisateur a consenti à une version spécifique des documents légaux. Les apps mobiles publient des mises à jour de CGU et de Politique de confidentialité ; il faut pouvoir identifier quels utilisateurs ont accepté quelle version pour cibler uniquement ceux qui n'ont pas encore re-consenti à la version courante.

## Décision identifiée

Quatre colonnes sont ajoutées sur l'entité `User` :
- `acceptedTosAt: timestamp nullable` — horodatage de la dernière acceptation des CGU
- `acceptedTosVersion: varchar(16) nullable` — version des CGU au moment de l'acceptation
- `acceptedPrivacyAt: timestamp nullable` — horodatage de la dernière acceptation de la Privacy Policy
- `acceptedPrivacyVersion: varchar(16) nullable` — version de la Privacy Policy au moment de l'acceptation

Deux constantes exportées dans `gdpr.service.ts` définissent les versions courantes :
```typescript
export const CURRENT_TOS_VERSION = '1.0';
export const CURRENT_PRIVACY_VERSION = '1.0';
```

La méthode `needsConsentRefresh(user: User)` compare les versions stockées sur l'utilisateur avec ces constantes. Si `user.acceptedTosVersion !== CURRENT_TOS_VERSION`, le champ `needsTosAcceptance: true` est retourné, signalant au client Flutter d'afficher une modale de re-consentement.

## Conséquences observées

### Positives
- Preuve légale du consentement : les colonnes `acceptedTosAt` + `acceptedTosVersion` constituent une trace horodatée et versionnée exploitable en cas de litige ou d'audit CNIL.
- Ciblage précis du re-consentement : seuls les utilisateurs dont la version stockée diffère de la version courante sont sollicités, évitant les demandes inutiles.
- Zéro dépendance externe : le mécanisme est entièrement en base de données relationnelle, sans service tiers ni table de suivi supplémentaire.

### Négatives / Dette
- Point de fragilité unique : `CURRENT_TOS_VERSION` est une constante hardcodée dans un fichier de service. Toute modification (même accidentelle lors d'un merge) déclenche un re-consentement global. Aucune protection (commentaire d'avertissement visible, variable d'env, ou CI) n'est en place pour prévenir une modification non intentionnelle.
- Null = « jamais consenti » : les colonnes sont `nullable`, ce qui signifie que les comptes créés avant l'introduction du système de consentement ont `acceptedTosVersion = null`, et `needsTosAcceptance` sera `true` pour eux. C'est fonctionnellement correct mais peut produire une vague de re-consentement lors du déploiement initial.
- Absence de rate-limiting sur `POST /user/gdpr/consent` : un attaquant authentifié pourrait spammer l'endpoint et générer un grand nombre d'UPDATE inutiles.

## Recommandation

Garder. Le mécanisme est simple, conforme RGPD, et sans dette architecturale critique.

Deux actions recommandées :
1. Ajouter un commentaire d'avertissement explicite au-dessus de `CURRENT_TOS_VERSION` dans `gdpr.service.ts` indiquant les conséquences d'une modification.
2. Envisager une variable d'environnement (`CURRENT_TOS_VERSION`) pour que la version soit configurable sans modification de code, ce qui évite les modifications accidentelles au merge.
