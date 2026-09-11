import { Module } from '@nestjs/common';
import { RedisModule } from '../redis/redis.module.js';
import { AppJwtService } from './app-jwt.service.js';
import { InstallationTokenService } from './installation-token.service.js';
import { GithubApiService } from './github-api.service.js';

@Module({
  imports: [RedisModule],
  providers: [AppJwtService, InstallationTokenService, GithubApiService],
  exports: [AppJwtService, InstallationTokenService, GithubApiService],
})
export class GithubModule {}
