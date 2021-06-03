import * as vscode from 'vscode';
import * as sqlite from 'sqlite';
import * as path from "path";
import { getDB } from "./db";

/**
 * CodelensProvider
 */
export class CodelensProvider implements vscode.CodeLensProvider {

    private codeLenses: vscode.CodeLens[] = [];
    public _onDidChangeCodeLenses: vscode.EventEmitter<void> = new vscode.EventEmitter<void>();
    public readonly onDidChangeCodeLenses: vscode.Event<void> = this._onDidChangeCodeLenses.event;
	private db :sqlite.Database;

	private async init(rootPath :string): Promise<void> {
		this.db = await getDB();
	}

	async generateCodelens(editor: vscode.TextEditor, fsPath: string) {
		let codeLenses: vscode.CodeLens[] = []
		const linenoteScheme = 'linenote';
		const projectRoot = vscode.workspace.workspaceFolders[0].uri.fsPath;
		const reportedLines: number[] = []
		if (!projectRoot) {
			return codeLenses
		}
		await this.init(projectRoot)
		const relativePath = path.relative(projectRoot, fsPath);
		if (relativePath.startsWith("..")) {
			throw new Error("invalid file path");
		}

		let results = await this.db.all("SELECT * FROM linenote_notes WHERE fspath = ?", relativePath);
		if (results)
		{
			for (let row of results)
			{
				if(reportedLines.includes(row.line_no))
				{
					continue;
				}
				reportedLines.push(row.line_no);
				let from = editor.document.lineAt(row.line_no - 1).range.start;
				let to = editor.document.lineAt(row.line_no - 1).range.end;
				let range = new vscode.Range(from, to);
				let url = linenoteScheme + ':' + fsPath + "_L" + row.line_no;
				let c: vscode.Command = {
					title: row.note_content,
					command: "vscode.open",
					arguments: [vscode.Uri.parse(url),
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

    public async provideCodeLenses(document: vscode.TextDocument, token: vscode.CancellationToken): Promise<vscode.CodeLens[]> {
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

