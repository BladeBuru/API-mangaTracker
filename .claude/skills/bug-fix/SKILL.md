---
name: bug-fix
description: Workflow 4 phases pour investiguer, corriger et documenter un bug dans Manga Tracker API — identification du layer (Controller / Service / DTO / Entity / Auth), correction respectant les patterns, mise à jour known-issues.md, génération d'un rapport tableau.
---

# Skill : Bug Fix — Manga Tracker API

Workflow structuré pour corriger un bug et générer un rapport.

---

## Phase 1 — Investigation

1. Lire le memory-bank :
   - `.claude/memory-bank/known-issues.md` — bug déjà documenté ?
   - `.claude/memory-bank/architecture.md` — comprendre le module concerné

2. Reproduire le bug :
   - Quel endpoint ? (`GET /api/...`)
   - Conditions de reproduction ?
   - Comportement attendu vs observé ?

3. Identifier la cause :
   - Module : `mangas` | `library` | `user` | `auth`
   - Layer : Controller | Service | DTO | Entity | Auth
   - Régression ? (Quand ça fonctionnait-il ?)

---

## Phase 2 — Correction

1. Corriger dans le bon layer :
   - Erreur de validation → DTO
   - Erreur logique → service
   - Erreur de route → controller
   - Erreur d'entité → entité TypeORM (+ migration si schéma modifié)

2. Vérifier les impacts :
   - Régression possible ailleurs ?
   - D'autres modules utilisent-ils le code corrigé ?

3. Respecter les règles :
   - Pas de logique ajoutée dans le controller
   - Exceptions NestJS descriptives
   - Pas d'`any` introduit
   - Pas de bypass des throttlers ou guards

---

## Phase 3 — Validation

Checklist post-fix :

- [ ] Bug reproduit et corrigé
- [ ] Pas de régression introduite
- [ ] Pas de `console.log` de debug oubliés
- [ ] Exceptions NestJS appropriées (message descriptif)
- [ ] Auth JWT toujours en place sur les routes privées
- [ ] Si schéma DB modifié → migration créée
- [ ] Tests unitaires ajoutés ou mis à jour si applicable

---

## Phase 4 — Documentation

1. Mettre à jour `.claude/memory-bank/known-issues.md` :
   - Déplacer le bug de "Actifs" vers "Résolus"
   - Documenter cause + solution

2. Générer le rapport (format tableau ci-dessous).

---

## Format Rapport (prêt à copier)

```markdown
| Catégorie | Détails |
|-----------|---------|
| **Date** | [jour mois année] |
| **Durée** | [X minutes] |
| **Sévérité** | 🔴 Critique / 🟠 Haute / 🟡 Moyenne / 🟢 Basse |
| **Module** | [mangas | library | user | auth] |
| **Fichier** | [nom-fichier.ts] |
| **Type** | Bug fix / Hotfix |
| | |
| **🐛 Symptôme** | [Ce que l'utilisateur observe] |
| | |
| **🛠️ Fix #1** | [Titre] : [Description] → [Impact] |
| **🛠️ Fix #2** | [Titre] : [Description] → [Impact] |
| | |
| **✅ Validation** | ✅ [Point 1]<br>✅ [Point 2] |
| **⚠️ Note** | [Contexte technique si nécessaire] |
```

---

**Rappel** : `known-issues.md` mis à jour APRÈS chaque bug résolu.
