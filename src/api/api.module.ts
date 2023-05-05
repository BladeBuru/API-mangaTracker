import { Module } from '@nestjs/common';
import { UserModule } from './user/user.module';
import {MangasModule} from "@/api/mangas/mangas.module";

@Module({
  imports: [UserModule, MangasModule]
})
export class ApiModule {}
