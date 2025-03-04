/*
 * workspaceMap.ts
 *
 * Workspace management related functionality.
 */

import { createDeferred } from './common/deferred';
import { LanguageServerBase, WellKnownWorkspaceKinds, WorkspaceServiceInstance } from './languageServerBase';

export class WorkspaceMap extends Map<string, WorkspaceServiceInstance> {
    private _defaultWorkspacePath = '<default>';

    override delete(key: string): boolean {
        const workspace = this.get(key);
        if (!workspace) {
            return false;
        }

        // Make sure we shutdown BG for the workspace.
        workspace.serviceInstance.backgroundAnalysisProgram.backgroundAnalysis?.shutdown();
        return super.delete(key);
    }

    hasMultipleWorkspaces(kind?: string) {
        if (this.size === 0 || this.size === 1) {
            return false;
        }

        let count = 0;
        for (const kv of this) {
            if (!kind || kv[1].kind === kind) {
                count++;
            }

            if (count > 1) {
                return true;
            }
        }

        return false;
    }

    getNonDefaultWorkspaces(kind?: string): WorkspaceServiceInstance[] {
        const workspaces: WorkspaceServiceInstance[] = [];
        this.forEach((workspace) => {
            if (!workspace.rootPath) {
                return;
            }

            if (kind && workspace.kind !== kind) {
                return;
            }

            workspaces.push(workspace);
        });

        return workspaces;
    }

    getWorkspaceForFile(ls: LanguageServerBase, filePath: string): WorkspaceServiceInstance {
        let bestRootPath: string | undefined;
        let bestInstance: WorkspaceServiceInstance | undefined;

        this.forEach((workspace) => {
            if (workspace.rootPath) {
                // Is the file is under this workspace folder?
                if (filePath.startsWith(workspace.rootPath)) {
                    // Is this the fist candidate? If not, is this workspace folder
                    // contained within the previous candidate folder? We always want
                    // to select the innermost folder, since that overrides the
                    // outer folders.
                    if (bestRootPath === undefined || workspace.rootPath.startsWith(bestRootPath)) {
                        bestRootPath = workspace.rootPath;
                        bestInstance = workspace;
                    }
                }
            }
        });

        // If there were multiple workspaces or we couldn't find any,
        // create a default one to use for this file.
        if (bestInstance === undefined) {
            let defaultWorkspace = this.get(this._defaultWorkspacePath);
            if (!defaultWorkspace) {
                // If there is only one workspace, use that one.
                const workspaceNames = [...this.keys()];
                if (workspaceNames.length === 1) {
                    return this.get(workspaceNames[0])!;
                }

                // Create a default workspace for files that are outside
                // of all workspaces.
                defaultWorkspace = {
                    workspaceName: '',
                    rootPath: '',
                    rootUri: '',
                    serviceInstance: ls.createAnalyzerService(this._defaultWorkspacePath),
                    kind: WellKnownWorkspaceKinds.Default,
                    disableLanguageServices: false,
                    disableOrganizeImports: false,
                    disableWorkspaceSymbol: false,
                    isInitialized: createDeferred<boolean>(),
                    searchPathsToWatch: [],
                };
                this.set(this._defaultWorkspacePath, defaultWorkspace);
                ls.updateSettingsForWorkspace(defaultWorkspace).ignoreErrors();
            }

            return defaultWorkspace;
        }

        return bestInstance;
    }
}
