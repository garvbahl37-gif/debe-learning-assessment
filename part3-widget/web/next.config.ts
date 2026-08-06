import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // `@debe/shared` ships TypeScript source rather than a build artefact, so
  // Next has to compile it like first-party code. That is the trade for having
  // the frontend and the Cloud Function import the same files: no build step
  // between editing a type and seeing the error in both places.
  transpilePackages: ["@debe/shared"],

  typedRoutes: true,
};

export default nextConfig;
