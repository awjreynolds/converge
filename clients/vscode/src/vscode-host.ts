import * as vscode from "vscode";
import type { ChangeUnit, PairingSession } from "@converge/core";

import type { ExtensionHostCapabilities } from "./controller.js";
import { decodePanelAction, type PanelAction, type PanelSnapshot } from "./panel.js";

const SESSION_KEY = "converge.activePairingSession";
const SNAPSHOTS_KEY = "converge.diffSnapshots";
const SNAPSHOT_SCHEME = "converge-snapshot";

interface StoredSnapshot {
  content: string;
  filePath: string;
}

type StoredSnapshots = Record<string, StoredSnapshot>;

function activeRevision(change: ChangeUnit) {
  return change.revisions.find((revision) => revision.revision === change.currentRevision);
}

function snapshotKey(sessionId: string, changeId: string, filePath: string): string {
  return JSON.stringify([sessionId, changeId, filePath]);
}

export class SnapshotContentProvider implements vscode.TextDocumentContentProvider {
  constructor(private readonly context: vscode.ExtensionContext) {}

  provideTextDocumentContent(uri: vscode.Uri): string {
    const stored = this.context.workspaceState.get<StoredSnapshots>(SNAPSHOTS_KEY, {});
    const snapshot = stored[uri.query];
    if (!snapshot) throw new Error("The immutable Converge baseline is no longer available.");
    return snapshot.content;
  }

  async capture(session: PairingSession): Promise<void> {
    const stored = { ...this.context.workspaceState.get<StoredSnapshots>(SNAPSHOTS_KEY, {}) };
    let changed = false;
    for (const change of session.changes) {
      if (!["proposed", "discussing", "redirected", "approved"].includes(change.status)) continue;
      const revision = activeRevision(change);
      if (!revision) continue;
      for (const file of revision.affectedFiles) {
        const key = snapshotKey(session.id, change.id, file.path);
        if (stored[key]) continue;
        const uri = resolveWorkspaceFile(file.path);
        if (!uri) continue;
        try {
          const content = await vscode.workspace.fs.readFile(uri);
          stored[key] = { content: new TextDecoder().decode(content), filePath: file.path };
          changed = true;
        } catch {
          stored[key] = { content: "", filePath: file.path };
          changed = true;
        }
      }
    }
    if (changed) await this.context.workspaceState.update(SNAPSHOTS_KEY, stored);
  }

  uriFor(sessionId: string, changeId: string, filePath: string): vscode.Uri | undefined {
    const key = snapshotKey(sessionId, changeId, filePath);
    const stored = this.context.workspaceState.get<StoredSnapshots>(SNAPSHOTS_KEY, {});
    if (!stored[key]) return undefined;
    return vscode.Uri.from({
      scheme: SNAPSHOT_SCHEME,
      path: `/${filePath}`,
      query: key,
    });
  }
}

function workspaceRoot(): vscode.Uri | undefined {
  const folders = vscode.workspace.workspaceFolders;
  return folders?.length === 1 ? folders[0]?.uri : undefined;
}

function resolveWorkspaceFile(filePath: string): vscode.Uri | undefined {
  const root = workspaceRoot();
  if (!root || filePath.length === 0 || filePath.includes("\u0000")) return undefined;
  const uri = vscode.Uri.joinPath(root, ...filePath.split(/[\\/]/));
  const folder = vscode.workspace.getWorkspaceFolder(uri);
  return folder?.uri.toString() === root.toString() ? uri : undefined;
}

function webviewHtml(webview: vscode.Webview, extensionUri: vscode.Uri): string {
  const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, "dist", "webview.js"));
  const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, "media", "panel.css"));
  const csp = [
    "default-src 'none'",
    `script-src ${webview.cspSource}`,
    `style-src ${webview.cspSource}`,
    `img-src ${webview.cspSource} data:`,
    `font-src ${webview.cspSource}`,
  ].join("; ");
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="${csp}">
  <link rel="stylesheet" href="${styleUri}">
  <title>Converge Reasoning Panel</title>
</head>
<body>
  <div id="root" aria-live="polite"></div>
  <script src="${scriptUri}"></script>
</body>
</html>`;
}

export class ReasoningPanelProvider implements vscode.WebviewViewProvider {
  static readonly viewType = "converge.reasoning";

  private view: vscode.WebviewView | undefined;
  private snapshot: PanelSnapshot | undefined;
  private actionHandler: ((action: PanelAction) => Promise<void>) | undefined;

  constructor(private readonly extensionUri: vscode.Uri) {}

  onAction(handler: (action: PanelAction) => Promise<void>): void {
    this.actionHandler = handler;
  }

  async publish(snapshot: PanelSnapshot): Promise<void> {
    this.snapshot = snapshot;
    await this.view?.webview.postMessage({ type: "snapshot", snapshot });
  }

  currentSnapshot(): PanelSnapshot | undefined {
    return this.snapshot;
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = {
      enableScripts: true,
      localResourceRoots: [
        vscode.Uri.joinPath(this.extensionUri, "dist"),
        vscode.Uri.joinPath(this.extensionUri, "media"),
      ],
    };
    view.webview.html = webviewHtml(view.webview, this.extensionUri);
    view.webview.onDidReceiveMessage(async (message: unknown) => {
      const action = decodePanelAction(message);
      if (!action || !this.actionHandler) return;
      await this.actionHandler(action);
    });
    if (this.snapshot) void this.publish(this.snapshot);
  }
}

export class VsCodeHostCapabilities implements ExtensionHostCapabilities {
  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly panel: ReasoningPanelProvider,
    private readonly snapshots: SnapshotContentProvider,
  ) {}

  isWorkspaceTrusted(): boolean {
    return vscode.workspace.isTrusted;
  }

  async readSession(): Promise<PairingSession | undefined> {
    return this.context.workspaceState.get<PairingSession>(SESSION_KEY);
  }

  async writeSession(session: PairingSession): Promise<void> {
    await this.snapshots.capture(session);
    await this.context.workspaceState.update(SESSION_KEY, session);
  }

  async publishSnapshot(snapshot: PanelSnapshot): Promise<void> {
    await this.panel.publish(snapshot);
  }

  async openDiff(
    session: PairingSession,
    changeId: string,
    requestedFilePath: string | undefined,
  ): Promise<void> {
    const change = session.changes.find((candidate) => candidate.id === changeId);
    const revision = change && activeRevision(change);
    const filePath = requestedFilePath ?? revision?.affectedFiles[0]?.path;
    if (!change || !revision || !filePath) {
      throw new Error("This Change Unit does not identify a file to compare.");
    }
    if (!revision.affectedFiles.some((file) => file.path === filePath)) {
      throw new Error("The requested file is not part of this Change Unit.");
    }
    const right = resolveWorkspaceFile(filePath);
    if (!right) throw new Error("The requested diff is outside the active workspace.");
    const left = this.snapshots.uriFor(session.id, change.id, filePath);
    if (!left) {
      throw new Error("No pre-change baseline was captured for this file.");
    }
    await vscode.commands.executeCommand(
      "vscode.diff",
      left,
      right,
      `${revision.title} — ${filePath}`,
      { preview: true },
    );
  }

  async applyWorkspaceEdit(edits: readonly WorkspaceFileEdit[]): Promise<boolean> {
    this.assertTrusted();
    const workspaceEdit = new vscode.WorkspaceEdit();
    for (const edit of edits) {
      const uri = resolveWorkspaceFile(edit.filePath);
      if (!uri) throw new Error(`Cannot edit outside the active workspace: ${edit.filePath}`);
      try {
        const document = await vscode.workspace.openTextDocument(uri);
        workspaceEdit.replace(
          uri,
          new vscode.Range(new vscode.Position(0, 0), document.positionAt(document.getText().length)),
          edit.content,
        );
      } catch {
        workspaceEdit.createFile(uri, { ignoreIfExists: false });
        workspaceEdit.insert(uri, new vscode.Position(0, 0), edit.content);
      }
    }
    return vscode.workspace.applyEdit(workspaceEdit);
  }

  async runTask(taskName: string): Promise<number | undefined> {
    this.assertTrusted();
    const tasks = await vscode.tasks.fetchTasks();
    const task = tasks.find((candidate) => candidate.name === taskName);
    if (!task) throw new Error(`VS Code task not found: ${taskName}`);
    const execution = await vscode.tasks.executeTask(task);
    return new Promise((resolve) => {
      const processSubscription = vscode.tasks.onDidEndTaskProcess((event) => {
        if (event.execution === execution) {
          processSubscription.dispose();
          taskSubscription.dispose();
          resolve(event.exitCode);
        }
      });
      const taskSubscription = vscode.tasks.onDidEndTask((event) => {
        if (event.execution === execution) {
          processSubscription.dispose();
          taskSubscription.dispose();
          resolve(undefined);
        }
      });
    });
  }

  openTerminal(command: string, name = "Converge"): void {
    this.assertTrusted();
    const terminal = vscode.window.createTerminal({ name });
    terminal.show();
    terminal.sendText(command, true);
  }

  private assertTrusted(): void {
    if (!vscode.workspace.isTrusted) {
      throw new Error("Trust this workspace before applying edits or running commands.");
    }
  }
}

export interface WorkspaceFileEdit {
  filePath: string;
  content: string;
}

export function registerVscodeHost(
  context: vscode.ExtensionContext,
  panel: ReasoningPanelProvider,
): { host: VsCodeHostCapabilities; snapshots: SnapshotContentProvider } {
  const snapshots = new SnapshotContentProvider(context);
  context.subscriptions.push(
    vscode.workspace.registerTextDocumentContentProvider(SNAPSHOT_SCHEME, snapshots),
    vscode.window.registerWebviewViewProvider(ReasoningPanelProvider.viewType, panel),
  );
  return { host: new VsCodeHostCapabilities(context, panel, snapshots), snapshots };
}
