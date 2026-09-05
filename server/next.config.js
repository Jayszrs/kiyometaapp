const path = require('path');

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Pin the workspace root so Turbopack doesn't scan up to C:\Users\... looking
  // for lockfiles (that scan slows first compile and prints a warning).
  turbopack: {
    root: path.join(__dirname),
  },
};

module.exports = nextConfig;
