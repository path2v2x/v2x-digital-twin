import type { NextConfig } from "next";

// Loopback twin HTTP origin; MJPEG streams are proxied same-origin.
const twinHttpOrigin = process.env.TWIN_HTTP_ORIGIN?.trim();
// Development only: fetch map bundles and camera rigs from a deployed twin host.
const devUpstream = process.env.TWIN_DEV_UPSTREAM?.trim().replace(/\/+$/, "");
const allowedDevOrigins = (process.env.TWIN_ALLOWED_DEV_ORIGINS ?? "")
  .split(",")
  .map((origin) => origin.trim())
  .filter(Boolean);

const nextConfig: NextConfig = {
  async rewrites() {
    return [
      ...(twinHttpOrigin ? [{ source: "/streams/:path*", destination: `${twinHttpOrigin}/streams/:path*` }] : []),
      ...(devUpstream
        ? ["map-bundles", "drive-rigs"].map((prefix) => ({ source: `/${prefix}/:path*`, destination: `${devUpstream}/${prefix}/:path*` }))
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
