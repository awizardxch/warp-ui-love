/** @type {import('next').NextConfig} */

import { createRequire } from "module";
const require = createRequire(import.meta.url);

const CopyPlugin = require('copy-webpack-plugin');

const nextConfig = {
  // The wagmi transports run in the browser, so the RPC URLs must be inlined
  // into the client bundle at build time. Without this they are undefined
  // there and viem falls back to rate-limited public endpoints.
  env: {
    ETH_RPC: process.env.ETH_RPC ?? "",
    BASE_RPC: process.env.BASE_RPC ?? "",
  },
  webpack: (config, { isServer }) => {
    if (!isServer) {
      // Replace 'fs' with an empty module on the client-side
      config.resolve.fallback = { fs: false };

      config.plugins.push(
        new CopyPlugin({
          patterns: [
            { from: 'public/blsjs.wasm', to: 'static/chunks' }
          ],
        })
      );
    }

    config.externals.push('pino-pretty', 'lokijs', 'encoding')
    return config;
  },
  async rewrites() {
    return [
      {
        source: '/:path*/blsjs.wasm',
        destination: '/blsjs.wasm',
      }
    ]
  },
};

export default nextConfig;
