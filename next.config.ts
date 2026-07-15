import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  async redirects() {
    return [
      {
        // Old signed-in hub; the explorer is home now. Temporary (307) on
        // purpose: browsers cache 308s forever, and a future dashboard may
        // reclaim /app.
        source: '/app',
        destination: '/explorer',
        permanent: false,
      },
    ];
  },
};

export default nextConfig;
