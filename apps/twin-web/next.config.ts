import type { NextConfig } from "next";

// Development only: fetch map bundles, actor models, camera rigs, detection history and camera archive from a deployed twin host.
const devUpstream = process.env.TWIN_DEV_UPSTREAM?.trim().replace(/\/+$/, "");
const allowedDevOrigins = (process.env.TWIN_ALLOWED_DEV_ORIGINS ?? "")
  .split(",")
  .map((origin) => origin.trim())
  .filter(Boolean);

const nextConfig: NextConfig = {
  async rewrites() {
    return [
      ...(devUpstream
        ? ["map-bundles", "catalog", "drive-rigs", "detections", "archive"].map((prefix) => ({ source: `/${prefix}/:path*`, destination: `${devUpstream}/${prefix}/:path*` }))
        : []),
    ];
  },
  allowedDevOrigins: ["127.0.0.1", "localhost", ...allowedDevOrigins],
  webpack(config) {
    config.resolve.extensionAlias = {
      ...config.resolve.extensionAlias,
      ".js": [".ts", ".tsx", ".js"],
      ".jsx": [".tsx", ".jsx"],
    };
    return config;
  },
};

export default nextConfig;
