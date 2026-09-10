import { Module } from '@nestjs/common';
import { RedisModule } from '../redis/redis.module.js';
import { AppJwtService } from './app-jwt.service.js';
import { InstallationTokenService } from './installation-token.service.js';

@Module({
  imports: [RedisModule],
  providers: [AppJwtService, InstallationTokenService],
  exports: [AppJwtService, InstallationTokenService],
})
export class GithubModule {}
