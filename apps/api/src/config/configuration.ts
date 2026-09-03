export default () => ({
  port: parseInt(process.env.PORT ?? '', 10) || 3333,
  database: {
    url: process.env.DATABASE_URL,
  },
  redis: {
    url: process.env.REDIS_URL,
  },
  github: {
    appId: process.env.GITHUB_APP_ID,
    clientId: process.env.GITHUB_APP_CLIENT_ID,
    webhookSecret: process.env.GITHUB_WEBHOOK_SECRET,
    privateKeyBase64: process.env.GITHUB_APP_PRIVATE_KEY_BASE64,
  },
});
