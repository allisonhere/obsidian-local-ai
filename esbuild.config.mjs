import esbuild from "esbuild";

const prod = process.argv[2] === "production";
const ctx = await esbuild.context({
  entryPoints: ["main.ts"],
  bundle: true,
  external: ["obsidian", "electron"],
  platform: "node",
  format: "cjs",
  target: "es2020",
  outfile: "main.js",
  sourcemap: prod ? false : "inline",
  minify: prod,
});
if (prod) {
  await ctx.rebuild();
  process.exit(0);
}
await ctx.watch();
