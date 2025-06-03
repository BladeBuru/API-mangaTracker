import { Module } from '@nestjs/common';
import { UserModule } from './user/user.module';
import { GlobalHttpModule } from '@/api/config/http.module';
import { LibraryModule } from '@/api/library/library.module';
import { MangasModule } from '@/api/mangas/mangas.module';

@Module({
  imports: [UserModule, GlobalHttpModule, LibraryModule, MangasModule],
})
export class ApiModule {}
