import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  // Base path differs per deployment:
  //   - GitHub Pages serves from https://<user>.github.io/ReviewIQ/ (subpath).
  //   - Vercel serves from the domain root (Vercel sets VERCEL=1 at build time).
  // An explicit VITE_BASE always wins if set.
  base: process.env.VITE_BASE ?? (process.env.VERCEL ? "/" : "/ReviewIQ/"),
  plugins: [react(), tailwindcss()],
});
