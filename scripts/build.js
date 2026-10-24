// Bundles the viewer UI into dist/ (the main process runs unbundled from src/main).
const esbuild = require("esbuild");
const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..");
const out = path.join(root, "dist");
fs.mkdirSync(out, { recursive: true });

esbuild.buildSync({
  entryPoints: [path.join(root, "src/renderer/app.js")],
  outfile: path.join(out, "app.js"),
  bundle: true,
  format: "iife",
  platform: "browser",
  target: "chrome120",
  minify: process.argv.includes("--minify"),
  logLevel: "warning",
});

for (const file of ["index.html", "styles.css"]) {
  fs.copyFileSync(path.join(root, "src/renderer", file), path.join(out, file));
}
console.log("Built dist/");
