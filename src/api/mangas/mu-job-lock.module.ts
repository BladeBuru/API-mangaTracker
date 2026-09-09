import { Module } from '@nestjs/common';
import { MuJobLockService } from './mu-job-lock.service';

/**
 * Porte le verrou MangaUpdates PARTAGÉ, et lui seul.
 *
 * Extrait de `MangasModule` (2026-09-09) à l'arrivée d'un job MU vivant dans
 * un autre module (`ReaderSignalModule`). Tant que `MuJobLockService` était
 * un simple provider de `MangasModule`, tout module qui le re-déclarait en
 * obtenait une **seconde instance** — et le verrou ne verrouillait plus
 * rien : deux jobs auraient pu frapper MU en même temps, soit le double du
 * débit convenu (1 req / 2 s). Exactement le risque que ce verrou existe
 * pour écarter.
 *
 * Un module dédié, importé par tous les modules porteurs d'un job MU,
 * garantit l'instance unique par construction plutôt que par convention.
 * (Même pattern que `RecoCacheModule` / `DismissalModule` : module autonome,
 * aucun cycle.)
 */
@Module({
  providers: [MuJobLockService],
  exports: [MuJobLockService],
})
export class MuJobLockModule {}
