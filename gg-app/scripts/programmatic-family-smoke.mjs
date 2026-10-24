import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { smokeLabels, smokeButton } from "./programmatic-execution-smoke-checks.mjs";

// Python plugin family (non-JavaScript). Detection is path-shape only; folder names are neutral.
const values = {
  "plugins/csv": { name: "csv", title: "CSV" },
  "plugins/json": { name: "json", title: "JSON" },
  "plugins/xml": { name: "xml", title: "XML" },
};
const template = [
  {
    path: "plugins/{{name}}/README.md",
    content: "# {{title}} plugin\n\nReads {{title}} records through the shared plugin interface.\n",
  },
  {
    path: "plugins/{{name}}/__init__.py",
    content: '"""{{title}} plugin."""\n\nNAME = "{{name}}"\n',
  },
  {
    path: "plugins/{{name}}/plugin.toml",
    content: '[plugin]\nname = "{{name}}"\nentry = "plugins.{{name}}"\n',
  },
];
const render = (text, member) =>
  text.replace(/\{\{(\w+)\}\}/g, (_, key) => values[member]?.[key] ?? "");
const handWritten =
  "# XML plugin\n\nHand-maintained notes: namespaces need manual review before release.\n";
export const familyOutcome = "NATIVE FAMILY: add plugins members from one reference";
export const familyCommandName = "plugins-generator";
export const familyCreatedFile = "plugins/json/plugin.toml";
export const familyCreatedContent = render(template[2].content, "plugins/json");
export const familyRequestCount = 19;

/** Synthetic project files only; expectations stay in this script. LF throughout. */
export function familySeedFiles() {
  const files = {
    ".gitignore": ".gg/\n",
    "AGENTS.md":
      "Disposable family fixture. Never create, apply or execute without a separate approval.\n",
    CONTRIBUTING:
      "Each plugin folder under plugins/ carries __init__.py, plugin.toml and README.md that differ only in the plugin name and title. plugins/csv is the complete example.\n",
  };
  const keep = {
    "plugins/csv": null,
    "plugins/json": ["__init__.py", "README.md"],
    "plugins/xml": ["__init__.py", "plugin.toml"],
  };
  for (const [member, only] of Object.entries(keep))
    for (const file of template) {
      const target = render(file.path, member);
      if (!only || only.some((name) => target.endsWith(`/${name}`)))
        files[target] = render(file.content, member);
    }
  files["plugins/xml/README.md"] = handWritten;
  return files;
}
export function seedFamily(project) {
  for (const [file, content] of Object.entries(familySeedFiles())) {
    mkdirSync(dirname(join(project, file)), { recursive: true });
    writeFileSync(join(project, file), content);
  }
}

const evidencePaths = [
  "CONTRIBUTING",
  "plugins/csv/README.md",
  "plugins/csv/__init__.py",
  "plugins/csv/plugin.toml",
];
function draft(familyId) {
  return {
    name: familyCommandName,
    requiredTools: ["bash"],
    markdown: `---\nname: ${familyCommandName}\ndescription: Generate one family member from the verified reference\n---\n## Inputs\nFamily member path\n## Outputs\nThe member's files\n## Required tools\nbash\n## Limits\nFamily members only; no installs\n## Arguments\nAppend the member path\n`,
    generator: {
      familyId,
      kind: "directory",
      reference: "plugins/csv",
      placeholders: ["name", "title"],
      members: Object.keys(values).map((member) => ({
        path: member,
        values: ["name", "title"].map((key) => ({ key, value: values[member][key] })),
      })),
      files: template,
    },
    requirement: {
      version: 1,
      desiredOutcome: "Generate plugins members from one reference",
      capabilityKind: "script-backed",
      inputs: ["Member name and title"],
      outputs: ["Member files"],
      prerequisites: ["Node runtime"],
      risks: ["Template drift from the reference"],
      verificationExpectations: ["Reproduces the reference byte for byte"],
    },
  };
}

function texts(value) {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(texts);
  if (value && typeof value === "object")
    return [value.text, value.content].flatMap((item) => (item === undefined ? [] : texts(item)));
  return [];
}
/** Latest host-delivered setup facts from a Responses request body (history keeps earlier scans). */
export function familySetupFacts(body) {
  const prompt = body.input
    .flatMap(texts)
    .findLast((text) => text.includes("Host-owned exact facts"));
  const json = prompt
    ?.split("already collected, do not repeat):\n")[1]
    ?.split("\nReusable host evidence receipts:")[0];
  assert.ok(json, "Setup facts were delivered");
  return JSON.parse(json).setupFacts.item_families;
}

/** One provider response per request; arrays become parallel tool calls. */
export function familyResponseEvents(step) {
  if (typeof step === "string") return [{ type: "response.output_text.delta", delta: step }];
  return (Array.isArray(step) ? step : [step]).flatMap((item, index) => [
    { type: "response.output_item.added", output_index: index, item },
    {
      type: "response.function_call_arguments.done",
      output_index: index,
      item_id: item.id,
      arguments: item.arguments,
    },
    { type: "response.output_item.done", output_index: index, item },
  ]);
}

/** Pure scripted provider: request number → the next model step. */
export function familyWorkflowStep(number, body, state = {}) {
  assert.ok(
    Number.isInteger(number) && number >= 1 && number <= familyRequestCount,
    "Unexpected family provider dispatch",
  );
  assert.ok(
    Array.isArray(body.input) && Array.isArray(body.tools),
    "Responses request has input and tools",
  );
  const offered = body.tools.map((tool) => tool.name);
  const output = (id) => {
    const matches = body.input.filter(
      (item) => item.type === "function_call_output" && item.call_id === id,
    );
    assert.equal(matches.length, 1, `One result for ${id}`);
    return String(matches[0].output);
  };
  const parsed = (id) => JSON.parse(output(id));
  const receipt = (id) => {
    const found = /Host receipt IDs: (receipt-[a-f0-9-]+)/.exec(output(id))?.[1];
    assert.ok(found, `Host receipt for ${id}`);
    return found;
  };
  const tool = (id, name, args) => {
    assert.ok(offered.includes(name), `Fixture can only call an offered tool: ${name}`);
    return {
      type: "function_call",
      id: `fc_${id}`,
      call_id: id,
      name,
      arguments: JSON.stringify(args),
    };
  };
  const reads = (prefix) => [
    ...evidencePaths.map((file, index) =>
      tool(`${prefix}-read-${index}`, "read", { file_path: file }),
    ),
    tool(`${prefix}-catalog`, "command_information", { action: "list" }),
  ];
  const noMutation = () => {
    for (const name of ["bash", "write", "edit", "programmatic_scan"])
      assert.ok(!offered.includes(name), `No ${name} during discovery/review`);
  };
  switch (number) {
    // 1-2 Detect + recommend (setup discovery; no profile).
    case 1: {
      noMutation();
      assert.ok(!offered.includes("programmatic_command"), "Discovery offers no command tool");
      const family = familySetupFacts(body).families.find(
        (item) => item.kind === "sibling-directories" && item.parent === "plugins",
      );
      assert.deepEqual(
        family?.members.map((member) => member.path),
        Object.keys(values),
      );
      assert.deepEqual(
        family.members.map((member) => member.missing),
        [[], ["plugin.toml"], []],
      );
      state.familyId = family.id;
      return reads("discovery");
    }
    case 2:
      assert.ok(state.familyId, "Family identity from setup facts");
      return tool("family-submit", "programmatic_advisory_result", {
        version: 2,
        kind: "advisory",
        coverage: {
          status: "limited",
          scope: "plugins",
          reason: "Scripted fixture, not live-model evaluation",
        },
        recommendations: [
          {
            version: 2,
            kind: "advisory",
            outcome: familyOutcome,
            rationale: "Members repeat the same files and differ only in name and title",
            uncertainty: "Path shape and the inspected files only; behaviour is unverified",
            workflow: {
              trigger: "A new member is added",
              representativeCase: "One member lacks a shared file",
              inputs: ["Member name", "Member title"],
              currentProcess: ["Copy a member by hand and rename"],
              output: "The member's files",
              successCheck: "Every member has the shared files",
              affectedSubproject: { scope: "subproject", path: "plugins" },
              mutationBoundary: "Only family member files",
              repeatability: { basis: "observed", explanation: "Three similar members" },
            },
            choice: {
              kind: "generate-from-reference",
              generator: {
                version: 1,
                familyId: state.familyId,
                members: Object.keys(values),
                sharedShape: ["README.md", "__init__.py", "plugin.toml"],
                varyingInputs: ["Member name", "Member title"],
                reference: {
                  kind: "existing-member",
                  path: "plugins/csv",
                  reason: "The only member with every shared file",
                },
                risks: ["Hand-edited member files may differ from the template"],
                verificationExpectations: ["The generator reproduces the reference exactly"],
              },
            },
            alternatives: [
              { kind: "reuse-command", reasonNotSelected: "No existing generator" },
              { kind: "manual", reasonNotSelected: "Members are added repeatedly" },
            ],
            evidence: {
              version: 1,
              items: evidencePaths.map((file, index) => ({
                basis: "observed",
                source: receipt(`discovery-read-${index}`),
                code: "family-member",
                severity: "info",
                message: `Inspected ${file}`,
                location: { path: file },
              })),
            },
          },
        ],
      });
    // An accepted advisory result ends the run, so no model turn follows a submission.
    // 3-7 Review: bounded inspection; creation, apply and shell are refused.
    case 3:
      noMutation();
      assert.ok(output("family-submit").includes("Recommendations"));
      return reads("review");
    case 4:
      // Step 4's command_information call already owns `review-catalog`; call IDs must stay unique.
      return tool("review-inventory", "programmatic_command", {
        action: "inspect",
        proposal: draft(state.familyId),
      });
    case 5:
      return tool("review-draft", "programmatic_command", {
        action: "inspect",
        proposal: {
          ...draft(state.familyId),
          review: {
            inventorySha256: parsed("review-inventory").catalog.sha256,
            disposition: "create",
            rationale: "No existing generator for this family",
          },
        },
      });
    case 6: {
      const inspected = parsed("review-draft");
      assert.equal(inspected.status, "proposal");
      return [
        tool("review-no-create", "programmatic_command", {
          action: "create",
          handle: inspected.handle,
        }),
        tool("review-no-apply", "programmatic_command", {
          action: "apply_family",
          handle: inspected.handle,
          preview_id: "00000000-0000-4000-8000-000000000000",
        }),
      ];
    }
    case 7:
      for (const id of ["review-no-create", "review-no-apply"])
        assert.doesNotMatch(output(id), /"created":\s*true|"status":\s*"applied"/, `${id} refused`);
      return "NATIVE FAMILY REVIEW SETTLED: inspected only; creation and apply refused.";
    // 8-14 Create (card #1), reproduce the reference, preview without writing.
    case 8:
      assert.ok(JSON.stringify(body.input).includes("NATIVE FAMILY CREATE REQUEST"));
      return tool("create-load", "tool_search", { query: "programmatic_command" });
    case 9:
      return tool("create-catalog", "programmatic_command", {
        action: "inspect",
        proposal: draft(state.familyId),
      });
    case 10:
      return tool("create-draft", "programmatic_command", {
        action: "inspect",
        proposal: {
          ...draft(state.familyId),
          review: {
            inventorySha256: parsed("create-catalog").catalog.sha256,
            disposition: "create",
            rationale: "No existing generator for this family",
          },
        },
      });
    case 11:
      assert.equal(parsed("create-draft").status, "proposal");
      state.handle = parsed("create-draft").handle;
      return tool("create", "programmatic_command", { action: "create", handle: state.handle });
    case 12:
      assert.equal(parsed("create").created, true);
      return tool("verify", "programmatic_command", {
        action: "verification",
        handle: state.handle,
      });
    case 13: {
      const verified = parsed("verify");
      assert.equal(verified.generator?.generatorVerified, true);
      assert.equal(verified.generator?.referenceCheck?.result, "passed");
      assert.ok(
        verified.report.cases.some(
          (item) => item.category === "reproduces-reference" && item.result === "passed",
        ),
      );
      return tool("preview", "programmatic_command", {
        action: "preview_family",
        handle: state.handle,
      });
    }
    case 14: {
      const preview = parsed("preview");
      assert.equal(preview.status, "previewed");
      assert.equal(preview.written, false);
      assert.deepEqual(
        preview.members.map((member) => [member.path, member.status]),
        [
          ["plugins/json", "ready"],
          ["plugins/xml", "conflict"],
        ],
      );
      state.preview = preview;
      return "NATIVE FAMILY CREATION SETTLED: generator verified against the reference; preview wrote nothing.";
    }
    // 15-18 Apply (card #2) to the fresh preview only.
    case 15:
      assert.ok(JSON.stringify(body.input).includes("NATIVE FAMILY APPLY REQUEST"));
      return tool("apply-load", "tool_search", { query: "programmatic_command" });
    case 16:
      return tool("apply-preview", "programmatic_command", {
        action: "preview_family",
        handle: state.handle,
      });
    case 17:
      assert.equal(parsed("apply-preview").written, false);
      return tool("apply", "programmatic_command", {
        action: "apply_family",
        handle: state.handle,
        preview_id: parsed("apply-preview").previewId,
      });
    case 18: {
      const applied = parsed("apply");
      assert.equal(applied.status, "applied");
      assert.equal(applied.report.status, "partial");
      assert.deepEqual(
        applied.report.members.map((member) => [member.path, member.status]),
        [
          ["plugins/json", "created"],
          ["plugins/xml", "skipped"],
        ],
      );
      state.applied = applied;
      return "NATIVE FAMILY APPLY SETTLED: partial; the hand-written member was skipped.";
    }
    // 19 Rescan: applied members are no longer missing files; acceptance ends the run.
    case 19: {
      noMutation();
      const family = familySetupFacts(body).families.find(
        (item) => item.kind === "sibling-directories" && item.parent === "plugins",
      );
      assert.equal(family?.id, state.familyId);
      assert.ok(
        family.members.every((member) => member.missingCount === 0),
        "Rescan sees every member complete",
      );
      return tool("rescan-submit", "programmatic_advisory_result", {
        version: 2,
        kind: "advisory",
        coverage: { status: "limited", scope: "plugins", reason: "Rescan only" },
        recommendations: [],
      });
    }
  }
}

/** Native driver over the real developer launch; only provider transport is scripted. */
export async function runFamilySmoke({
  client,
  click,
  waitFor,
  requests,
  observe,
  projectSnapshot,
  providerFailure,
}) {
  const invoke = (command, args = {}) =>
    client.evaluate(
      `window.__TAURI_INTERNALS__.invoke(${JSON.stringify(command)}, ${JSON.stringify({ paneId: "primary", ...args })})`,
    );
  const family = () =>
    Object.fromEntries(
      Object.entries(projectSnapshot()).filter(([file]) => file.startsWith("plugins/")),
    );
  const gg = () => Object.keys(projectSnapshot()).filter((file) => file.startsWith(".gg/"));
  const settled = async (count) => {
    await waitFor(`family provider boundary ${count}`, async () => {
      const failure = providerFailure();
      if (failure) throw failure;
      return requests.length === count && !(await invoke("agent_state")).running;
    });
    assert.equal(requests.length, count);
  };
  const send = async (text) => {
    await client.evaluate(
      `(() => { const e=document.querySelector('.agent-pane textarea'); const setter=Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set; setter.call(e,${JSON.stringify(text)}); e.dispatchEvent(new Event('input',{bubbles:true})); return true; })()`,
    );
    await client.evaluate(
      `document.querySelector('.agent-pane textarea').dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',code:'Enter',bubbles:true}))`,
    );
  };
  const cards = [];
  const answerCard = async (label, beforeCount, beforeFamily) => {
    const question = await waitFor(`${label} native card`, () =>
      client.evaluate(
        `window.fixtureEvents.filter(e=>e.type==='ask_user').map(e=>e.data).find(q=>!${JSON.stringify(cards.map((card) => card.id))}.includes(q.id))`,
      ),
    );
    assert.equal(
      requests.length,
      beforeCount,
      `${label}: no provider dispatch while the card is open`,
    );
    assert.deepEqual(family(), beforeFamily, `${label}: no family file changes before the answer`);
    const option = question.questions[0].options[0].label;
    const target = `Array.from(document.querySelectorAll('.ask-band:not(.is-done):not(.is-closed) [data-ask-option]')).find(b=>b.textContent.includes(${JSON.stringify(option)}))`;
    await waitFor(`${label} rendered`, () => client.evaluate(`Boolean(${target})`));
    await observe?.(`${label}-open`);
    await client.evaluate(`(${target}).click()`);
    cards.push({ id: question.id, label, question: question.questions[0].question });
    return question;
  };

  const original = family();
  assert.deepEqual(gg(), [], "Seed has no command or lifecycle files");
  // 1. Detect + recommend.
  await click("Opportunities");
  await click(smokeLabels.discover);
  await waitFor("family candidate", () =>
    client.evaluate(
      `Array.from(document.querySelectorAll('.programmatic-chat button')).some(b=>b.textContent.trim()===${JSON.stringify(familyOutcome)})`,
    ),
  );
  assert.equal(requests.length, 2);
  await click(familyOutcome);
  assert.equal(requests.length, 2, "Selection does not dispatch review");
  assert.equal(
    await client.evaluate(
      `document.querySelector('.programmatic-chat')?.textContent.includes('Make one, copy the rest')`,
    ),
    true,
  );
  await observe?.("family-recommended");
  // 2. Review: inspection only.
  await click("Review this idea");
  await waitFor("family review settled", () =>
    client.evaluate(
      `document.body.innerText.includes('NATIVE FAMILY REVIEW SETTLED') && document.querySelector('.programmatic-chat')?.textContent.includes('Review ready. Nothing was changed.')`,
    ),
  );
  await settled(7);
  assert.equal(
    await client.evaluate(`window.fixtureEvents.filter(e=>e.type==='ask_user').length`),
    0,
    "Review raises no approval card",
  );
  assert.deepEqual(family(), original);
  assert.deepEqual(gg(), [], "Review creates no command, profile or lifecycle files");
  await observe?.("family-reviewed");
  // 3-5. Create (card #1), verify, preview.
  await click("Opportunities"); // Close the panel; creation lives in the ordinary transcript.
  await send(
    "NATIVE FAMILY CREATE REQUEST: create the reviewed generator, verify it and preview the family.",
  );
  const creation = await answerCard("family-creation", 11, original);
  await settled(14);
  assert.ok(
    gg().includes(`.gg/commands/${familyCommandName}.md`),
    "Generator command created after card #1",
  );
  assert.deepEqual(family(), original, "Verification and preview write no family file");
  // 6. Apply (card #2).
  await send("NATIVE FAMILY APPLY REQUEST: apply the previewed generator to the family.");
  const apply = await answerCard("family-apply", 17, original);
  await settled(18);
  assert.notEqual(creation.id, apply.id);
  assert.match(apply.questions[0].question, /Write the previewed generator output/);
  assert.doesNotMatch(creation.questions[0].question, /Write the previewed generator output/);
  const after = family();
  const changedFamily = Object.keys({ ...original, ...after })
    .filter((file) => original[file] !== after[file])
    .sort();
  assert.deepEqual(
    changedFamily,
    [familyCreatedFile],
    "Only the planned create was written; conflict bytes untouched",
  );
  assert.equal(after["plugins/xml/README.md"], original["plugins/xml/README.md"]);
  await observe?.("family-applied");
  // 7. Rescan.
  await click("Opportunities");
  await click(smokeLabels.discover);
  await settled(familyRequestCount);
  assert.deepEqual(family(), after, "Rescan writes nothing");
  assert.equal(cards.length, 2, "Exactly two separate approval cards");
  await observe?.("family-rescanned");
  return {
    passed: true,
    familyWorkflow: true,
    requests: requests.length,
    cards,
    changedFamilyFiles: changedFamily,
    generatedFiles: gg(),
    minimized: false,
    real: [
      "native developer webview",
      "Rust proxy",
      "session-owned discovery and review",
      "generator creation, verification, preview and apply",
      "native approval cards",
    ],
    mocked: ["local scripted Azure Responses provider", "MCP disabled"],
  };
}
