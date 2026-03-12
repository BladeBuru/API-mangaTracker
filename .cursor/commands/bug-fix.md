# Commande : Bug Fix — Manga Tracker API

Quand cette commande est déclenchée, suivre ce workflow pour corriger un bug et générer un rapport.

---

## Phase 1 : Investigation

1. **Lire le memory-bank** :
   - `.cursor/memory-bank/known-issues.md` — Le bug est-il déjà documenté ?
   - `.cursor/memory-bank/architecture.md` — Comprendre le module concerné

2. **Reproduire le bug** :
   - Quel endpoint est concerné ? (`GET /api/...`)
   - Quelles sont les conditions de reproduction ?
   - Quel est le comportement attendu vs observé ?

3. **Identifier la cause** :
   - Module concerné : `mangas` | `library` | `user` | `auth`
   - Layer concerné : Controller | Service | DTO | Entity | Auth
   - Est-ce une régression ? (Quand ça fonctionnait-il ?)

---

## Phase 2 : Correction

1. **Corriger dans le bon layer** :
   - Erreur de validation → corriger le DTO
   - Erreur logique → corriger le service
   - Erreur de route → corriger le controller
   - Erreur d'entité → corriger l'entité TypeORM

2. **Vérifier les impacts** :
   - La correction peut-elle créer une régression ailleurs ?
   - D'autres modules utilisent-ils le code corrigé ?

3. **Respecter les règles** :
   - Pas de logique ajoutée dans le controller
   - Exceptions NestJS descriptives
   - Pas d'`any` introduit

---

## Phase 3 : Validation

**Checklist post-fix** :

1. ✅ Bug reproduit et corrigé ?
2. ✅ Pas de régression introduite ?
3. ✅ Pas de `console.log` de debug oubliés ?
4. ✅ Exceptions NestJS appropriées (message descriptif) ?
5. ✅ Auth JWT toujours en place sur les routes privées ?

---

## Phase 4 : Documentation

1. **Mettre à jour `.cursor/memory-bank/known-issues.md`** :
   - Déplacer le bug de "Actifs" vers "Résolus"
   - Documenter la cause et la solution

2. **Générer le rapport** (format tableau ci-dessous)

---

## Format Rapport Bug Fix (prêt à copier)

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
| **🐛 Symptôme** | [Description courte — ce que l'utilisateur observe] |
| | |
| **🛠️ Fix #1** | [Titre] : [Description courte] → [Impact] |
| **🛠️ Fix #2** | [Titre] : [Description courte] → [Impact] |
| | |
| **✅ Validation** | ✅ [Point 1]<br>✅ [Point 2]<br>✅ [Point 3] |
| **⚠️ Note** | [Contexte technique si nécessaire] |
```

---

**Rappel** : Mettre à jour `known-issues.md` après chaque bug résolu.
