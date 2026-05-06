# Pre-Upgrade Checklist — Apps NAS TrueNAS

> **Pourquoi cette checklist ?** Le 5 mai 2026, l'upgrade Postgres 16 → 17 sur TrueNAS Goldeye a échoué silencieusement (`"Assuming this is a fresh install"` dans les logs) et **wipé toutes les données MangaTracker, n8n et Nextcloud**. Aucun snapshot ZFS automatique configuré + aucun dump quotidien actif → données récupérées seulement grâce à un dump manuel fait 8 mois plus tôt + le dataset `restore-browse` créé par TrueNAS pendant l'upgrade.
>
> **Cette checklist empêche que ça se reproduise.** À suivre AVANT TOUT upgrade d'app TrueNAS qui touche une base de données (Postgres, MariaDB, MySQL, etc.).

---

## ✅ Avant l'upgrade — checklist obligatoire

### 1. Snapshot ZFS manuel (1 min)

Sur le NAS via SSH :

```bash
# Snapshot récursif manuel pré-upgrade (couvre tous les sous-datasets)
TIMESTAMP=$(date +%Y-%m-%d_%H-%M)
sudo docker run --rm --privileged --pid=host -v /:/host alpine chroot /host \
  zfs snapshot -r "Pool 1/ix-apps/app_mounts/postgres@manual-pre-upgrade-${TIMESTAMP}"

# Vérification
sudo docker run --rm --privileged --pid=host -v /:/host alpine chroot /host \
  zfs list -t snapshot | grep "manual-pre-upgrade-${TIMESTAMP}"
```

**Datasets à snapshotter selon l'app upgradée :**
- Toute app utilisant Postgres partagé : `Pool 1/ix-apps/app_mounts/postgres`
- Nextcloud : `Pool 1/ix-apps/app_mounts/nextcloud-db` (si dataset distinct)
- n8n : `Pool 1/ix-apps/app_mounts/n8n`
- MariaDB partagé : `Pool 1/ix-apps/app_mounts/mariadb` (si présent)

### 2. Dump SQL natif (1-2 min)

Pour chaque DB Postgres concernée :

```bash
TIMESTAMP=$(date -u +%Y-%m-%d_%H-%M)

# pg_dump format custom (compressé, restorable)
sudo docker exec ix-postgres-postgres-1 pg_dump \
  -U postgres -F c MangaTracker \
  -f /tmp/MangaTracker_PRE-UPGRADE_${TIMESTAMP}.dump

sudo docker cp ix-postgres-postgres-1:/tmp/MangaTracker_PRE-UPGRADE_${TIMESTAMP}.dump \
  ~/manga-tracker-backups/

# Vérification du dump (size > 5KB minimum)
ls -lh ~/manga-tracker-backups/MangaTracker_PRE-UPGRADE_${TIMESTAMP}.dump
```

### 3. Copie du dump hors-NAS (1 min)

Le dump sur le NAS = SPOF. Copie sur ta machine locale :

```bash
# Depuis ta machine locale
scp -i ~/.ssh/manga-tracker -P 5200 \
  admin@192.168.1.119:~/manga-tracker-backups/MangaTracker_PRE-UPGRADE_*.dump \
  ./local-backups/
```

### 4. Vérifier que les protections automatiques tournent

```bash
# Cron jobs ZFS snapshot doivent être présents et activés
midclt call cronjob.query | grep -i "DB snapshots"

# Workflow GitHub db-backup doit avoir un run récent
gh run list --workflow=db-backup-mangatracker --limit 3 --repo BladeBuru/API-mangaTracker
```

### 5. Note ce que tu fais (5 sec)

```bash
echo "$(date -u +%Y-%m-%d_%H:%M) - Upgrade Postgres 17 → 18 (raison: ...)" >> ~/upgrade-log.txt
```

---

## 🚨 Si l'upgrade échoue / les données ont disparu

### Étape 1 — NE PAS PANIQUER, NE PAS REDÉMARRER LE NAS

Le pire est de redémarrer ou de relancer un upgrade. Les anciennes données existent probablement encore quelque part :
- Dataset `restore-browse` créé automatiquement par TrueNAS lors de l'upgrade
- Datasets `*-bak-*` créés par les versions antérieures du script
- Snapshots ZFS récents (si Niveau 1 actif)
- Dumps `~/manga-tracker-backups/` (si Niveau 2 actif)

### Étape 2 — Inventaire des sources de récup

```bash
# Snapshots ZFS récents (les plus précieux)
sudo docker run --rm --privileged --pid=host -v /:/host alpine chroot /host \
  zfs list -t snapshot | grep -i "postgres\|nextcloud-db\|n8n"

# Datasets ZFS de backup automatique TrueNAS
sudo docker run --rm --privileged --pid=host -v /:/host alpine chroot /host \
  zfs list | grep -E "data-bak-|restore-browse"

# Dumps manuels
ls -lh ~/manga-tracker-backups/

# Tous les data dirs Postgres présents sur le NAS
sudo docker run --rm -v /mnt:/m:ro alpine \
  find /m -name PG_VERSION -maxdepth 12 2>/dev/null
```

### Étape 3 — Restaurer depuis la source la plus récente

Pour un snapshot ZFS (le plus simple) :
```bash
# Cloner le snapshot pour explorer sans casser
sudo zfs clone Pool\ 1/ix-apps/app_mounts/postgres/data@snapshot-name \
  Pool\ 1/ix-apps/app_mounts/postgres-recovery
```

Pour un dump custom :
```bash
# Restore dans la DB après recreation
sudo docker exec ix-postgres-postgres-1 pg_restore \
  -U postgres -d MangaTracker /tmp/dump.dump
```

Voir [PROCEDURE-RECOVERY.md](./PROCEDURE-RECOVERY.md) pour les détails complets.

---

## 🔒 Protections actives sur ce NAS (mai 2026)

### Niveau 1 — Snapshots ZFS automatiques (NAS-local)
- **Cron #6 — toutes les heures à :00** : snapshot récursif Postgres+n8n, rétention 7 jours
- **Cron #7 — daily 03:15** : snapshot récursif Postgres+n8n, rétention 30 jours
- Script : `/mnt/Pool 1/scripts/zfs-db-snapshots.sh`

### Niveau 2 — Dumps PostgreSQL off-site (GitHub Actions)
- Workflow : `.github/workflows/db-backup.yml` (`db-backup-mangatracker`)
- Schedule : daily 03:00 UTC
- Stockage : NAS (`~/manga-tracker-backups/`, 30 derniers) + GitHub Artifacts (90 jours)
- Sanity check : abort si dump < 5KB

### Niveau 3 — Cette checklist pré-upgrade (humain)
- À suivre avant tout upgrade d'app TrueNAS qui touche une DB

### Niveau 4 — (à ajouter) Replication ZFS off-site
- TODO : configurer un replication task ZFS vers un autre NAS ou cloud

---

## 📞 Contacts urgents

- TrueNAS forums Goldeye / Electric Eel : https://www.truenas.com/community/
- Documentation midclt API : https://www.truenas.com/docs/api/
- Script de récupération projet : `~/manga-tracker-backups/`

---

*Dernière mise à jour : 2026-05-06 — après incident upgrade Postgres 16→17*
