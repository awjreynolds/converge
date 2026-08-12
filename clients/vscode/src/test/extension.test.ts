import assert from "node:assert/strict";
import * as vscode from "vscode";

const extensionId = "converge-dev.converge-vscode";

export async function run(): Promise<void> {
  await activatesAndRegistersPublicCommands();
  console.log("PASS open-panel activates the extension and registers public commands");
  await handlesUnavailableAgentSafely();
  console.log("PASS start-session handles an unavailable agent safely");
}

async function activatesAndRegistersPublicCommands(): Promise<void> {
    const extension = vscode.extensions.getExtension(extensionId);
    assert.ok(extension, `Expected ${extensionId} to be installed in the Extension Host`);

    await vscode.commands.executeCommand("converge.openPanel");

    assert.equal(extension.isActive, true);
    const commands = await vscode.commands.getCommands(true);
    assert.ok(commands.includes("converge.openPanel"));
    assert.ok(commands.includes("converge.startSession"));
}

async function handlesUnavailableAgentSafely(): Promise<void> {
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
}
