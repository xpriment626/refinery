import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { hashSkillTree, inspectManagedCodexSkill, installManagedCodexSkill } from "./skill-installer.ts";

function seedBundle(root: string, body: string): string {
  const source = path.join(root, "bundle");
  fs.mkdirSync(path.join(source, "agents"), { recursive: true });
  fs.writeFileSync(path.join(source, "SKILL.md"), body);
  fs.writeFileSync(path.join(source, "agents/openai.yaml"), "display_name: Refinery\n");
  return source;
}

test("managed skill installs, refreshes unchanged content, and preserves customization", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "refinery-managed-skill-"));
  const source = seedBundle(root, "version one\n");
  const installPath = path.join(root, "codex/skills/refinery/SKILL.md");

  const installed = installManagedCodexSkill({ sourceDir: source, installPath, packageVersion: "0.3.0" });
  assert.equal(installed.action, "installed");
  assert.equal(installed.managed, true);

  fs.writeFileSync(path.join(source, "SKILL.md"), "version two\n");
  const upgraded = installManagedCodexSkill({ sourceDir: source, installPath, packageVersion: "0.3.1" });
  assert.equal(upgraded.action, "upgraded");
  assert.equal(fs.readFileSync(installPath, "utf8"), "version two\n");

  fs.appendFileSync(installPath, "customized\n");
  const before = hashSkillTree(path.dirname(installPath));
  const preserved = installManagedCodexSkill({ sourceDir: source, installPath, packageVersion: "0.3.1" });
  assert.equal(preserved.action, "preserved");
  assert.equal(preserved.conflict, true);
  assert.equal(hashSkillTree(path.dirname(installPath)), before);
  assert.match(preserved.next ?? "", /--force/);
});

test("the exact public v0.2 skill fixture remains recognized as legacy managed state", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "refinery-v02-skill-"));
  const source = path.resolve(import.meta.dirname, "../../test/fixtures/public-v0.2-skill");
  const installDir = path.join(root, "codex/skills/refinery");
  fs.cpSync(source, installDir, { recursive: true });
  const inspection = inspectManagedCodexSkill({
    sourceDir: path.resolve(import.meta.dirname, "../../skills/refinery"),
    installPath: path.join(installDir, "SKILL.md"),
  });
  assert.equal(hashSkillTree(installDir), "c8c8cf803697f2889e56d1bb387177c68210326ac041acf34e4f46b3c003bfbf");
  assert.equal(inspection.state, "stale-managed");
  assert.equal(inspection.managed, true);
  assert.equal(inspection.conflict, false);
});
