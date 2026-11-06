import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const components = new Set(["app", "controller", "agent"]);
const component = process.argv[2];
if (!components.has(component)) {
  console.error("Usage: npm run check -- <app|controller|agent>");
  process.exit(2);
}

const run = (command, args, cwd = root, extraEnv = {}) => {
  execFileSync(command, args, {
    cwd,
    stdio: "inherit",
    env: { ...process.env, CI: "1", AWS_PAGER: "", ...extraEnv },
  });
};

const artifactRoot = resolve(root, ".artifacts", component);
mkdirSync(artifactRoot, { recursive: true });
run("npm", ["run", "typecheck", "--workspace", "infrastructure"]);

if (component === "agent") {
  run("uv", ["run", "--project", "agent", "--locked", "python", "agent/package_runtime.py"]);
} else {
  run("npm", ["run", "typecheck", "--workspace", component]);
  run("npm", ["run", "build", "--workspace", component]);
  run("npm", ["run", "build:backend", "--workspace", component]);
}

const cdkOutput = resolve(artifactRoot, "cdk");
rmSync(cdkOutput, { recursive: true, force: true });
mkdirSync(cdkOutput, { recursive: true });
run("npx", ["tsx", "infrastructure/bin/synth.ts", component], root, { CDK_OUTDIR: cdkOutput });
