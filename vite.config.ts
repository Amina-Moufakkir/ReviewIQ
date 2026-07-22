import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  // Served from https://<user>.github.io/ReviewIQ/ on GitHub Pages, so assets
  // must resolve under the /ReviewIQ/ subpath.
  base: "/ReviewIQ/",
  plugins: [react(), tailwindcss()],
});
