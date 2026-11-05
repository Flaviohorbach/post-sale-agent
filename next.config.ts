import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  cacheComponents: true,
  partialPrefetching: true,
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
  // Native-style packages that load files or connect at runtime: keep them out of the bundle.
  serverExternalPackages: ["@electric-sql/pglite", "pg", "@langchain/langgraph-checkpoint-postgres"],
};

export default nextConfig;
