/** @type {import('next').NextConfig} */
const nextConfig = {
  images: {
    domains: ['zmpdkhpzcekclgjsmggs.supabase.co'],
  },
  webpack: (config, { isServer }) => {
    config.resolve.alias.canvas = false;
    if (!isServer) {
      config.resolve.fallback = {
        ...config.resolve.fallback,
        fs: false,
        net: false,
        tls: false,
        crypto: false,
      };
    }
    return config;
  },
  experimental: {
    // pdf-parse and @react-pdf/renderer both ship with Node-only
    // internals (fs access, native font parsing) that break when
    // Next tries to bundle them into the serverless function. Marking
    // them as external tells Next to require() them at runtime from
    // node_modules — the standard fix for the "PDF render failed"
    // class of errors that surface only in production.
    serverComponentsExternalPackages: ['pdf-parse', '@react-pdf/renderer'],
  },
};

module.exports = nextConfig;
