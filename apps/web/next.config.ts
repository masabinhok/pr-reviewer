import type { NextConfig } from 'next';

// The root .env is loaded by the dev and start scripts (dotenv -e ../../.env), where the
// server that reads it actually runs. Nothing is NEXT_PUBLIC_, so nothing reaches a browser.
const config: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  // next dev would otherwise write AGENTS.md and CLAUDE.md into apps/web when it detects an agent.
  agentRules: false,
};

export default config;
