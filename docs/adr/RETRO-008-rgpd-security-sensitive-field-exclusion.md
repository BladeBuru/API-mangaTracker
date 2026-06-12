# RETRO-008 — RGPD — Exclusion systématique des champs sensibles dans les exports

| Champ      | Valeur              |
|------------|---------------------|
| Statut     | Documenté (rétro)   |
| Date       | 2026-06-04          |
| Source     | Rétro-ingénierie    |
| Features   | gdpr                |

## Justification (politique ADR v2.3.0)

| Champ | Valeur |
|-------|--------|
| Catégorie | SECURITY |
| Q1 — Coût de revert > 1j ? | OUI — adopter une approche alternative cohérente (ex. `@Exclude()` class-transformer sur l'entité, ou DTOs de projection systématiques) nécessiterait de toucher `user.entity.ts`, tous les services qui retournent un `User` brut (`gdpr.service.ts`, `user.service.ts`, potentiellement `auth`), et de valider qu'aucun endpoint n'expose ces champs ; impact > 1 journée de refactoring transverse |
| Q2 — Non-déductible du code ? | OUI — la convention `delete (account as any).password` au runtime est un choix défensif explicite, non visible dans `package.json`, `tsconfig.json` ou la config TypeORM ; un dev qui lit le code sans connaître cette décision peut légitimement penser que l'entité est retournée telle quelle |
| Q3 — Impact transverse (≥ 2 specs) ? | OUI — la règle s'applique à `gdpr` (getDataSummary, exportUserData), à `auth` (les réponses qui retournent un User après login/register), et potentiellement à `profile` (si un endpoint GET /user retourne l'entité brute) |
| Q4 — Casse un invariant si ignoré ? | OUI — un dev qui ajoute un endpoint retournant un objet `User` sans appliquer l'exclusion exposerait le hash bcrypt (`password`) et le `googleId` dans les réponses API ; le hash bcrypt, bien qu'inutilisable directement, peut servir à des attaques offline ; le googleId permet de corréler des identités entre services |

> Validé contre la politique `.claude/rules/06-adr-policy.md`.

## Contexte

L'entité `User` contient des champs sensibles qui ne doivent jamais apparaître dans une réponse API : `password` (hash bcrypt) et `googleId` (identifiant OAuth Google). TypeORM charge l'entité complète depuis la base de données ; sans exclusion explicite, tout endpoint qui retourne directement un objet `User` expose ces champs.

## Décision identifiée

La convention adoptée est l'exclusion explicite au runtime par mutation de l'objet, directement dans les méthodes du service RGPD :

```typescript
// Dans GdprService.getDataSummary()
delete (account as any).password;
delete (account as any).googleId;
```

Cette approche est délibérément défensive et localisée : plutôt que de s'appuyer sur un serializer global ou des décorateurs sur l'entité (qui pourraient être contournés par des endpoints utilisant `@Res()` natif comme `exportUserData`), chaque point de sortie sensible applique l'exclusion explicitement.

La même contrainte est documentée dans `CLAUDE.md` :
> « JAMAIS retourner le `password` ni le `googleId` d'un User dans une réponse API »

## Conséquences observées

### Positives
- Sécurité défensive locale : même si un serializer global était désactivé ou contourné, les méthodes de `GdprService` ne retourneront jamais les champs sensibles.
- Auditabilité : la présence de `delete (account as any).password` est un signal visible lors de la revue de code qu'une attention particulière a été portée à cet endroit.

### Négatives / Dette
- Fragilité du cast `any` : `delete (account as any).password` contourne TypeScript strict. Si la propriété est renommée dans l'entité, la suppression silencieuse ne se produira plus (pas d'erreur de compilation). Un test unitaire vérifiant l'absence de `password` dans la sortie serait nécessaire.
- Convention non-universelle : la décision est documentée dans `CLAUDE.md` mais pas enforced automatiquement. Un nouveau dev qui ajoute un endpoint retournant `User` dans un autre module peut ne pas appliquer l'exclusion. L'approche `@Exclude()` sur l'entité avec `ClassSerializerInterceptor` global serait plus robuste, mais implique un refactoring transverse.
- Redondance avec `exportUserData` : la méthode `exportUserData` construit manuellement un objet `GdprExport` (mapping champ par champ) et n'inclut jamais `password`/`googleId` structurellement — l'exclusion est implicite par construction. Seule `getDataSummary` nécessite l'exclusion explicite car elle retourne l'entité brute.

## Recommandation

Garder la convention d'exclusion explicite pour les endpoints RGPD existants.

À terme, envisager le remplacement par `@Exclude()` + `ClassSerializerInterceptor` global sur l'entité `User` pour rendre l'invariant automatiquement appliqué. Ce refactoring doit vérifier que tous les endpoints utilisant `@Res()` natif (comme `exportUserData`) gèrent correctement le cas — le serializer NestJS ne s'applique pas quand `@Res()` est utilisé.
