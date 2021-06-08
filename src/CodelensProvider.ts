import * as vscode from 'vscode';
import * as sqlite from 'sqlite';
import { getDB } from "./db";
import { linenoteUrlFromFsPath, linenoteFullPath2RelativePath } from "./util"

/**
 * CodelensProvider
 */
export class CodelensProvider implements vscode.CodeLensProvider {

    private codeLenses: vscode.CodeLens[] = [];
    private _onDidChangeCodeLenses: vscode.EventEmitter<void> =
        new vscode.EventEmitter<void>();
    public readonly onDidChangeCodeLenses: vscode.Event<void> =
        this._onDidChangeCodeLenses.event;
	private db :sqlite.Database;

	private async init(): Promise<void> {
		this.db = await getDB();
	}

    public refresh(): void {
        this._onDidChangeCodeLenses.fire();
    }

	async generateCodelens(editor: vscode.TextEditor, fsPath: string) {
		let codeLenses: vscode.CodeLens[] = []
		const projectRoot = vscode.workspace.workspaceFolders[0].uri.fsPath;
		const reportedLines: number[] = []
        await this.init()
        if (!this.db)
        {
            return codeLenses;
        }
		if (!projectRoot) {
			return codeLenses
		}
		const relativePath = linenoteFullPath2RelativePath(fsPath);

		let results = await this.db.all(
            "SELECT * FROM linenote_notes WHERE fspath = ?",
            relativePath);
		if (results)
		{
			for (let row of results)
			{
				if(reportedLines.includes(row.line_no))
				{
					continue;
				}
                if(!row.note_content.trim())
                {
                    continue;
                }
				reportedLines.push(row.line_no);
				let from = editor.document.lineAt(row.line_no - 1).range.start;
				let to = editor.document.lineAt(row.line_no - 1).range.end;
				let range = new vscode.Range(from, to);
                let uri :vscode.Uri;
                try {
				    uri = linenoteUrlFromFsPath(fsPath, row.line_no);
                } catch (e) {
                    continue;
                }
				let c: vscode.Command = {
					title: row.note_content,
					command: "vscode.open",
					arguments: [uri,
						{
						  viewColumn: vscode.ViewColumn.Beside,
						  preview: false
						}]
				};
				codeLenses.push(new vscode.CodeLens(range, c));
			}
		}
		return codeLenses;
	}

    public async provideCodeLenses(document: vscode.TextDocument,
            token: vscode.CancellationToken): Promise<vscode.CodeLens[]> {
		const editor = vscode.window.activeTextEditor;
		const fsPath = editor.document.uri.fsPath;
		this.codeLenses = []
		return this.generateCodelens(editor, fsPath).then(
			res => {
				for (let codelens of res) {
					this.codeLenses.push(codelens)
				}
				return this.codeLenses;
			}
		);
    }

}

