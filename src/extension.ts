import * as vscode from "vscode";
import * as sqlite from 'sqlite';
import { CodelensProvider } from './CodelensProvider';
import * as path from "path";
import { getDB } from "./db";
import * as fs from 'fs';


let disposables: vscode.Disposable[] = [];

class File implements vscode.FileStat {

    type: vscode.FileType;
    ctime: number;
    mtime: number;
    size: number;

    name: string;
    data?: Uint8Array;

    constructor(name: string) {
        this.type = vscode.FileType.File;
        this.ctime = Date.now();
        this.mtime = Date.now();
        this.size = 0;
        this.name = name;
    }
}

export const activate = (context: vscode.ExtensionContext) => {
  let disposed: boolean = false;

  const codelensProvider = new CodelensProvider();

  vscode.languages.registerCodeLensProvider("*", codelensProvider);

  const linenoteScheme = 'linenote';

  const getProjectRoot = (fsPath :string) => {
	// console.debug(`getProjectRoot: fsPath = ${fsPath}`);
	const wpacefolder = vscode.workspace.getWorkspaceFolder(vscode.Uri.file(fsPath));
	if (!wpacefolder) {
		return "";
	}
	return wpacefolder.uri.fsPath;
  }

  class linenoteFS implements vscode.FileSystemProvider {

	private _emitter = new vscode.EventEmitter<vscode.FileChangeEvent[]>();
	readonly onDidChangeFile: vscode.Event<vscode.FileChangeEvent[]> = this._emitter.event;
	private db :sqlite.Database;

	private uri2path_lineno(uri: vscode.Uri) : [string, string, Number]{
		let full_path = uri.toString().replace(new RegExp("^" + linenoteScheme + ":"), "");
		let index = full_path.lastIndexOf("_L");
		if(index == -1) {
			throw new Error(`path ${full_path} is invalid`)
		}
		let fsPath = full_path.slice(0, index);
		let line_no = parseInt(full_path.slice(index + 2))
		if(isNaN(line_no))
		{
			throw new Error(`${full_path.slice(index + 2)} is not a number`)
		}
		let rootPath = getProjectRoot(fsPath);
		let relativePath = path.relative(rootPath, fsPath);
		return [rootPath, relativePath, line_no]
	}

	private async init(rootPath :string): Promise<void> {
		this.db = await getDB(rootPath);
	}


    async stat(uri: vscode.Uri): Promise<vscode.FileStat> {
		return new File(uri.toString());
    }

	async readFile(uri: vscode.Uri): Promise<Uint8Array> {
		let [rootPath, fsPath, line_no] = this.uri2path_lineno(uri);
		await this.init(rootPath);
		console.debug("readFile: " + fsPath);
		const res = await this.db.get("SELECT * FROM linenote_notes WHERE fspath = ? AND line_no = ?", fsPath, line_no)
		if(res)
		{
			// console.debug(res.note_content);
			return Buffer.from(res.note_content);
		}
		else
		{
			return Buffer.from("");
		}
	}
    watch(_resource: vscode.Uri): vscode.Disposable {
        // ignore, fires for all changes...
        return new vscode.Disposable(() => { });
    }
	async writeFile(uri: vscode.Uri, content: Uint8Array, options: { create: boolean, overwrite: boolean }): Promise<void> {
		let [rootPath, fsPath, line_no] = this.uri2path_lineno(uri);
		await this.init(rootPath);
		console.debug("writing file " + uri+ " :" + content.toString());
		await this.db.run("INSERT OR REPLACE INTO linenote_notes VALUES (?,?,?)",fsPath, line_no, content.toString())
	}
	createDirectory(uri: vscode.Uri): void {}
	readDirectory(uri: vscode.Uri): [string, vscode.FileType][] { return [] }
	async delete(uri: vscode.Uri): Promise<void> {
		let [rootPath, fsPath, line_no] = this.uri2path_lineno(uri);
		await this.init(rootPath);
		console.debug("deleting file " + fsPath);
		await this.db.run("DELETE FROM linenote_notes WHERE fspath = ? AND line_no = ?", fsPath, line_no)
	}
	async rename(oldUri: vscode.Uri, newUri: vscode.Uri, options: { overwrite: boolean }): Promise<void> {
		let [root_path, from_path, from_lineno] = this.uri2path_lineno(oldUri);
		let [_, to_path, to_lineno] = this.uri2path_lineno(newUri);
		await this.init(root_path);
		console.debug(`rename file: ${from_path}:${from_lineno} to ${to_path}:${to_lineno}`);
		const res = await this.db.get("SELECT * FROM linenote_notes WHERE fspath = ? AND line_no = ?", from_path, from_lineno)
		if(res)
		{
			// console.debug(res.note_content);
			await this.db.run("INSERT OR REPLACE INTO linenote_notes VALUES (?,?,?)", to_path, to_lineno, res.note_content)
			await this.db.run("DELETE FROM linenote_notes WHERE fspath = ? AND line_no = ?", from_path, from_lineno)
		}
	}
  }

  context.subscriptions.push(vscode.workspace.registerFileSystemProvider(linenoteScheme, new linenoteFS(), { isCaseSensitive: true }));

  const removeNotCorrespondingNotes = async () => {
	const editor = vscode.window.activeTextEditor;
	if(!editor)
	{
		return;
	}
	const fsPath = editor.document.uri.fsPath;
	let rootPath = getProjectRoot(fsPath)
	if(!rootPath)
	{
		return;
	}
	let db = await getDB(rootPath);
	let results = await db.all("SELECT DISTINCT fspath FROM linenote_notes");
	for(let row of results) {
		let fullPath = path.join(rootPath, row.fspath);
		if(!fs.existsSync(fullPath)) {
			console.debug(`auto deleted fullPath = ${fullPath}`);
			db.run("DELETE FROM linenote_notes WHERE fspath = ?", row.fspath)
			vscode.window.showInformationMessage(`Auto removed comments of ${row.fspath}.`)
			codelensProvider._onDidChangeCodeLenses.fire();
		}
	}
  }

  // watch notes that are not corresponding files
  const automaticallyDelete = async () => {
    if (disposed) {
      return;
    }
	const start = +new Date();
	await removeNotCorrespondingNotes();
	const duration = +new Date() - start;
	setTimeout(automaticallyDelete, Math.max(0, 60000 - duration));
  };
  automaticallyDelete();

  // get [from, to] from editor.selection
  const getSelectionLineRange = (editor: vscode.TextEditor): [number, number] => {
    return [
      // add 1 because editor's line number starts with 1, not 0
      editor.selection.start.line + 1, // from
      editor.selection.end.line + 1 // to
    ];
  };

  context.subscriptions.push(
    new vscode.Disposable(() => (disposed = true)),

    vscode.window.onDidChangeActiveTextEditor(editor => {}),
    vscode.workspace.onDidChangeTextDocument(event => {}),
    vscode.workspace.onDidCloseTextDocument(async event => {}),
    vscode.workspace.onDidChangeConfiguration(async event => {}),

    vscode.commands.registerCommand("linenotecodelens.openNote", async () => {
		const editor = vscode.window.activeTextEditor;
		if (editor) {
			const fsPath = editor.document.uri.fsPath;
			const [from, _] = getSelectionLineRange(editor);
			let uri = vscode.Uri.parse(linenoteScheme + ':/' + fsPath + "_L" + from);
			let doc :vscode.TextDocument;
			doc = await vscode.workspace.openTextDocument(uri);
			await vscode.window.showTextDocument(doc,
				{
					viewColumn: vscode.ViewColumn.Beside,
					preview: false
				});
			codelensProvider._onDidChangeCodeLenses.fire();
		}
    }),

    vscode.commands.registerCommand("linenotecodelens.removeNote", async () => {
		const editor = vscode.window.activeTextEditor;
		if (editor) {
			const fsPath = editor.document.uri.fsPath;
			const [from, _] = getSelectionLineRange(editor);
			let url = linenoteScheme + ':/' + fsPath + "_L" + from;
			let note_content = await vscode.workspace.fs.readFile(vscode.Uri.parse(url));
			if(!note_content.toString()) {
				return;
			}
			let selection = await vscode.window.showInformationMessage(`Delete comment on line ${from}?`, `Yes`, `No`);
			if(selection.toLowerCase() != "yes")
			{
				return
			}
			await vscode.workspace.fs.delete(vscode.Uri.parse(url), {useTrash: false});
			codelensProvider._onDidChangeCodeLenses.fire();
			vscode.window.showInformationMessage(`Successfully remove comment from line ${from}.`)
		}
    }),

	vscode.commands.registerCommand("linenotecodelens.moveDownNote", async () => {
		const editor = vscode.window.activeTextEditor;
		if(!editor)
		{
			return;
		}

		let line_number = await vscode.window.showInputBox({prompt: "Move down lines?" });
		let line_no = parseInt(line_number)
		if (isNaN(line_no))
		{
			return;
		}

		const fsPath = editor.document.uri.fsPath;
		const [from, _] = getSelectionLineRange(editor);
		let to = from + line_no;
		if(to > editor.document.lineCount || to < 0)
		{
			return;
		}

		let rootPath = getProjectRoot(fsPath)
		let db = await getDB(rootPath);
		let relativePath = path.relative(rootPath, fsPath);
		let results = await db.all("SELECT * FROM linenote_notes WHERE fspath = ? and line_no >= ?", relativePath, from);
		for(let row of results) {
			let from = row.line_no;
			let to  = row.line_no + line_no;
			let from_url = linenoteScheme + ':' + fsPath + "_L" + from;
			let to_url = linenoteScheme + ':' + fsPath + "_L" + to;
			let source_content = await vscode.workspace.fs.readFile(vscode.Uri.parse(from_url));
			if(!source_content.toString())
			{
				continue;
			}
			await vscode.workspace.fs.writeFile(vscode.Uri.parse(to_url), source_content);
			await vscode.workspace.fs.delete(vscode.Uri.parse(from_url));
		}
		codelensProvider._onDidChangeCodeLenses.fire();
		vscode.window.showInformationMessage(`Successfully move comment down ${line_no} lines from line ${from}.`)
	}),

    vscode.commands.registerCommand("linenotecodelens.moveNote", async () => {
		const editor = vscode.window.activeTextEditor;
		if(!editor)
		{
			return
		}

		let line_number = await vscode.window.showInputBox({prompt: "line number to move to" });
		let line_no = parseInt(line_number)
		if (isNaN(line_no))
		{
			return
		}

		if(line_no > editor.document.lineCount || line_no < 0)
		{
			return
		}

		const fsPath = editor.document.uri.fsPath;
		const [from, _] = getSelectionLineRange(editor);
		var from_url = linenoteScheme + ':' + fsPath + "_L" + from;
		var to_url = linenoteScheme + ':' + fsPath + "_L" + line_no;
		let source_content = await vscode.workspace.fs.readFile(vscode.Uri.parse(from_url));
		if(!source_content.toString())
		{
			return;
		}
		let target_content = await vscode.workspace.fs.readFile(vscode.Uri.parse(to_url));
		if(target_content.toString())
		{
			let selection = await vscode.window.showInformationMessage(`Overwrite comment on line ${line_no}?`, `Yes`, `No`);
			if(selection.toLowerCase() != "yes")
			{
				return
			}
		}
		console.debug("Move note from " + from_url + " to " + to_url);
		await vscode.workspace.fs.writeFile(vscode.Uri.parse(to_url), source_content);
		await vscode.workspace.fs.delete(vscode.Uri.parse(from_url));
		codelensProvider._onDidChangeCodeLenses.fire();
		vscode.window.showInformationMessage(`Successfully move comment from line ${from} to line ${line_no}.`)
    })
  );
};

export function deactivate() {
    if (disposables) {
        disposables.forEach(item => item.dispose());
    }
    disposables = [];
}
