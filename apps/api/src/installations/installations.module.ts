import { Module } from '@nestjs/common';
import { GithubModule } from '../github/github.module.js';
import { InstallationsService } from './installations.service.js';

@Module({
  imports: [GithubModule],
  providers: [InstallationsService],
  exports: [InstallationsService],
})
export class InstallationsModule {}
