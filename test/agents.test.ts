import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { discoverAgentProfiles, parseAgentProfile } from "../src/agents.js";

const SAMPLE = `---
name: scoutish
description: Read-only scout
model: [provider/fast, provider/fallback]
thinking: low
tools: [read, bash]
spawns: [scoutish]
blocking: true
autoloadSkills: [librarian]
triggers: [trace code, inspect source]
---
Inspect exact source and return concise evidence.`;

test("parses OMP-style markdown agent contracts", () => {
  const profile = parseAgentProfile("/tmp/scoutish.md", SAMPLE, "project");
  assert.equal(profile?.kind, "scoutish");
  assert.equal(profile?.model, "provider/fast");
  assert.deepEqual(profile?.fallback, ["provider/fallback"]);
  assert.deepEqual(profile?.tools, ["read", "bash"]);
  assert.deepEqual(profile?.spawns, ["scoutish"]);
  assert.equal(profile?.blocking, true);
  assert.deepEqual(profile?.autoloadSkills, ["librarian"]);
  assert.match(profile?.instructions ?? "", /Inspect exact source/);
});

test("project Pi agents override OMP and user definitions", async () => {
  const root = await mkdtemp(join(tmpdir(), "workflow-agents-"));
  const home = await mkdtemp(join(tmpdir(), "workflow-agents-home-"));
  await mkdir(join(root, ".pi", "agents"), { recursive: true });
  await mkdir(join(root, ".omp", "agents"), { recursive: true });
  await mkdir(join(home, ".pi", "agent", "agents"), { recursive: true });
  await writeFile(join(root, ".pi", "agents", "same.md"), SAMPLE.replace("scoutish", "same").replace("Read-only scout", "Pi project"));
  await writeFile(join(root, ".omp", "agents", "same.md"), SAMPLE.replace("scoutish", "same").replace("Read-only scout", "OMP project"));
  await writeFile(join(home, ".pi", "agent", "agents", "same.md"), SAMPLE.replace("scoutish", "same").replace("Read-only scout", "Pi user"));
  const profiles = await discoverAgentProfiles(root, home);
  assert.equal(profiles.find((profile) => profile.kind === "same")?.description, "Pi project");
});