import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  // Pages fetch live data per request (see lib/n8n.ts); nothing is cached.
  poweredByHeader: false,
  devIndicators: false,
};

export default nextConfig;
