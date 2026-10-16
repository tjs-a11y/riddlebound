import type { NextConfig } from "next";

// API-only app: the public site stays static on GitHub Pages (../site).
const nextConfig: NextConfig = {
  poweredByHeader: false,
};

export default nextConfig;
