import assert from "node:assert/strict";
import * as vscode from "vscode";

const extensionId = "converge-dev.converge-vscode";

suite("Converge extension public command surface", () => {
  test("activates through the open-panel command and registers the session command", async () => {
    const extension = vscode.extensions.getExtension(extensionId);
    assert.ok(extension, `Expected ${extensionId} to be installed in the Extension Host`);

    await vscode.commands.executeCommand("converge.openPanel");

    assert.equal(extension.isActive, true);
    const commands = await vscode.commands.getCommands(true);
    assert.ok(commands.includes("converge.openPanel"));
    assert.ok(commands.includes("converge.startSession"));
  });

  test("keeps the start-session command safe when the configured agent is unavailable", async () => {
    const configuredAgent = vscode.workspace
      .getConfiguration("converge")
      .get<string>("codexPath");
    assert.equal(configuredAgent, "__converge_test_missing_codex_executable__");

    await assert.doesNotReject(async () => {
      await vscode.commands.executeCommand(
        "converge.startSession",
        "Exercise the unavailable-agent boundary without executing an external agent",
      );
    });

    const extension = vscode.extensions.getExtension(extensionId);
    assert.equal(extension?.isActive, true);
  });
});
