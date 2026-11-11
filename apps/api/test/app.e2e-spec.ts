import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { AppModule } from './../src/app.module.js';

describe('GET / (e2e)', () => {
  let app: INestApplication;

  beforeEach(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    await app.init();
  });

  it('names the service and points at the health check', () => {
    return request(app.getHttpServer())
      .get('/')
      .expect(200)
      .expect({ name: 'pr-reviewer', health: '/healthz' });
  });

  afterEach(async () => {
    await app.close();
  });
});
