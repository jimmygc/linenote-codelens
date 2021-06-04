import * as vscode from "vscode";
import * as sqlite from 'sqlite';
import { CodelensProvider } from './CodelensProvider';
import { NoteTreeProvider, Entry, LineNoteEntryType } from './TreeViewProvider';
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

export const activate = async (context: vscode.ExtensionContext) => {
  let disposed: boolean = false;
  await getDB()

  const codelensProvider = new CodelensProvider();
  vscode.languages.registerCodeLensProvider("*", codelensProvider);

  const treeViewProvider = new NoteTreeProvider();
  let treeview = vscode.window.createTreeView(
      'LinenoteExplorer',
      { treeDataProvider: treeViewProvider, showCollapseAll: true});

  const linenoteScheme = 'linenote';

  class linenoteFS implements vscode.FileSystemProvider {

	private _emitter = new vscode.EventEmitter<vscode.FileChangeEvent[]>();
	readonly onDidChangeFile: vscode.Event<vscode.FileChangeEvent[]> =
        this._emitter.event;
	private db :sqlite.Database;

	private uri2path_lineno(uri: vscode.Uri) : [string, string, Number]{
		let full_path = uri.toString().replace(
            new RegExp("^" + linenoteScheme + ":"), "");
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
		let rootPath = vscode.workspace.workspaceFolders[0].uri.fsPath;
		let relativePath = path.relative(rootPath, fsPath);
		return [rootPath, relativePath, line_no]
	}

	private async init(rootPath :string): Promise<void> {
		this.db = await getDB();
	}


    async stat(uri: vscode.Uri): Promise<vscode.FileStat> {
		return new File(uri.toString());
    }

	async readFile(uri: vscode.Uri): Promise<Uint8Array> {
		let [rootPath, fsPath, line_no] = this.uri2path_lineno(uri);
		await this.init(rootPath);
		console.debug("readFile: " + fsPath);
		const res = await this.db.get(
            "SELECT * FROM linenote_notes WHERE fspath = ? AND line_no = ?",
            fsPath, line_no)
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
	async writeFile(uri: vscode.Uri, content: Uint8Array,
            options: { create: boolean, overwrite: boolean }): Promise<void> {
		let [rootPath, fsPath, line_no] = this.uri2path_lineno(uri);
		await this.init(rootPath);
		console.debug("writing file " + uri+ " :" + content.toString());
		const res = await this.db.get(
            "SELECT * FROM linenote_notes WHERE fspath = ? AND line_no = ?",
            fsPath, line_no)
        if(res)
        {
            await this.db.run(
                "UPDATE linenote_notes set note_content = ? \
                where fspath = ? AND line_no = ?",
                content.toString(), fsPath, line_no)
        }
        else
        {
            await this.db.run(
                "INSERT INTO linenote_notes(fspath, line_no, note_content) \
                 VALUES(?,?,?);",
                fsPath, line_no, content.toString())
        }
        treeViewProvider.refresh();
	}
	createDirectory(uri: vscode.Uri): void {}
	readDirectory(uri: vscode.Uri): [string, vscode.FileType][] { return [] }
	async delete(uri: vscode.Uri): Promise<void> {
		let [rootPath, fsPath, line_no] = this.uri2path_lineno(uri);
		await this.init(rootPath);
		console.debug("deleting file " + fsPath);
		await this.db.run(
            "DELETE FROM linenote_notes WHERE fspath = ? AND line_no = ?",
            fsPath, line_no)
        treeViewProvider.refresh();
	}
	async rename(oldUri: vscode.Uri, newUri: vscode.Uri,
                 options: { overwrite: boolean }): Promise<void> {
		let [root_path, from_path, from_lineno] = this.uri2path_lineno(oldUri);
		let [_, to_path, to_lineno] = this.uri2path_lineno(newUri);
		await this.init(root_path);
		console.debug(`rename file: ${from_path}:${from_lineno} to \
                      ${to_path}:${to_lineno}`);
		const res = await this.db.get(
            "SELECT * FROM linenote_notes WHERE fspath = ? AND line_no = ?",
            from_path, from_lineno)
		if(res)
		{
			// console.debug(res.note_content);to_path,
            //    to_lineno, res.note_content)
			await this.db.run(
                "UPDATE linenote_notes SET fspath = ?, line_no = ? \
                WHERE fspath = ? AND line_no = ?",
                to_path, to_lineno, from_path, from_lineno)
		}
        treeViewProvider.refresh();
	}
  }

  context.subscriptions.push(vscode.workspace.registerFileSystemProvider(
      linenoteScheme, new linenoteFS(), { isCaseSensitive: true }));
  context.subscriptions.push(treeview);
  const removeNotCorrespondingNotes = async () => {
	const editor = vscode.window.activeTextEditor;
	if(!editor)
	{
		return;
	}
	let rootPath = vscode.workspace.workspaceFolders[0].uri.fsPath;
	if(!rootPath)
	{
		return;
	}
	let db = await getDB();
	let results = await db.all("SELECT DISTINCT fspath FROM linenote_notes");
	for(let row of results) {
		let fullPath = path.join(rootPath, row.fspath);
		if(!fs.existsSync(fullPath)) {
			console.debug(`auto deleted fullPath = ${fullPath}`);
			db.run("DELETE FROM linenote_notes WHERE fspath = ?", row.fspath)
			vscode.window.showInformationMessage(
                `Auto removed notes of ${row.fspath}.`)
			codelensProvider.refresh();
            treeViewProvider.refresh();
		}
	}
    results = await db.all("SELECT * FROM linenote_notes");
    for(let row of results) {
        if(!row.note_content.toString().trim())
        {
            db.run(
                "DELETE FROM linenote_notes WHERE fspath = ? AND line_no = ?",
                row.fspath, row.line_no);
            vscode.window.showInformationMessage(`Auto removed empty note of \
                ${row.fspath}:${row.line_no}.`)
            codelensProvider.refresh();
            treeViewProvider.refresh();
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
  const getSelectionLineRange = (editor: vscode.TextEditor):
        [number, number] => {
    return [
      // add 1 because editor's line number starts with 1, not 0
      editor.selection.start.line + 1, // from
      editor.selection.end.line + 1 // to
    ];
  };

  context.subscriptions.push(
    new vscode.Disposable(() => (disposed = true)),

    vscode.window.onDidChangeActiveTextEditor(async editor => {
        // if (treeview.visible) {
        //     // treeViewProvider._onDidChangeTreeData.fire();
        //     const fsPath = editor.document.uri.fsPath;
        //     let rootPath = vscode.workspace.workspaceFolders[0].uri.fsPath;
        //     let relativePath = path.relative(rootPath, fsPath)
        //     await treeview.reveal(
        //         {fspath: relativePath, type:vscode.FileType.Directory, line_no:0},
        //         {focus: true, select: false, expand: true})
        // }
    }),
    vscode.window.onDidChangeTextEditorSelection (async e => {
        if (treeview.visible) {
            const editor = vscode.window.activeTextEditor;
            if (editor)
            {
                const fsPath = editor.document.uri.fsPath;
                let rootPath = vscode.workspace.workspaceFolders[0].uri.fsPath;
                const line_no = e.selections[0].start.line + 1;
                let relativePath = path.relative(rootPath, fsPath)
                let uri = vscode.Uri.parse(
                    linenoteScheme + ':/' + fsPath + "_L" + line_no);
                let content = await vscode.workspace.fs.readFile(uri);
                if(content.toString())
                {
                    treeview.reveal(
                        {fspath: relativePath,
                         type:LineNoteEntryType.Note, line_no:line_no},
                        {focus: false, select: true, expand: false})
                }
            }
        }
    }),
    vscode.workspace.onDidChangeTextDocument(event => {}),
    vscode.workspace.onDidCloseTextDocument(async event => {}),
    vscode.workspace.onDidChangeConfiguration(async event => {}),

    vscode.commands.registerCommand("linenotecodelens.openNote",
            async (resource?: Entry) => {
        if(resource && (resource.type == LineNoteEntryType.Note ||
            resource.type == LineNoteEntryType.StarNote)) {
            let rootPath = vscode.workspace.workspaceFolders[0].uri.fsPath;
            let full_path = path.join(rootPath, resource.fspath);
            let uri = vscode.Uri.parse(
                linenoteScheme + ':/' + full_path + "_L" + resource.line_no);
            console.log("delete node: " + uri);
            let doc = await vscode.workspace.openTextDocument(uri);
            await vscode.window.showTextDocument(doc,
                {
                    viewColumn: vscode.ViewColumn.Beside,
                    preview: false
                });
        }
        else
        {
            const editor = vscode.window.activeTextEditor;
            if (editor) {
                const fsPath = editor.document.uri.fsPath;
                const [from, _] = getSelectionLineRange(editor);
                let uri = vscode.Uri.parse(
                    linenoteScheme + ':/' + fsPath + "_L" + from);
                let doc :vscode.TextDocument;
                doc = await vscode.workspace.openTextDocument(uri);
                await vscode.window.showTextDocument(doc,
                    {
                        viewColumn: vscode.ViewColumn.Beside,
                        preview: false
                    });
                codelensProvider.refresh();
                treeViewProvider.refresh();
            }
        }
    }),

    vscode.commands.registerCommand("linenotecodelens.removeNote",
            async (resource?: Entry) => {
        if(resource && (resource.type == LineNoteEntryType.Note ||
            resource.type == LineNoteEntryType.StarNote)) {
            let rootPath = vscode.workspace.workspaceFolders[0].uri.fsPath;
            let full_path = path.join(rootPath, resource.fspath);
            let uri = vscode.Uri.parse(
                linenoteScheme + ':/' + full_path + "_L" + resource.line_no);
            console.log("delete node: " + uri);
            await vscode.workspace.fs.delete(uri, {useTrash: false});
            codelensProvider.refresh();
            treeViewProvider.refresh();
        }
        else
        {
            const editor = vscode.window.activeTextEditor;
            if (editor) {
                const fsPath = editor.document.uri.fsPath;
                const [from, _] = getSelectionLineRange(editor);
                let url = linenoteScheme + ':/' + fsPath + "_L" + from;
                let note_content =
                    await vscode.workspace.fs.readFile(vscode.Uri.parse(url));
                if(!note_content.toString()) {
                    return;
                }
                let selection = await vscode.window.showInformationMessage(
                    `Delete note on line ${from}?`, `Yes`, `No`);
                if(selection.toLowerCase() != "yes")
                {
                    return
                }
                await vscode.workspace.fs.delete(
                    vscode.Uri.parse(url), {useTrash: false});
                codelensProvider.refresh();
                treeViewProvider.refresh();
                vscode.window.showInformationMessage(
                    `Successfully remove note from line ${from}.`)
            }
        }
    }),

	vscode.commands.registerCommand("linenotecodelens.moveNoteAndSubsequential",
            async (resource?: Entry) => {
        let fsPath:string;
        let from:number;
        let to:number;
        if(resource && (resource.type == LineNoteEntryType.Note ||
            resource.type == LineNoteEntryType.StarNote))
        {
            let rootPath = vscode.workspace.workspaceFolders[0].uri.fsPath;
            fsPath = path.join(rootPath, resource.fspath);
            from = resource.line_no;
            let input = await vscode.window.showInputBox({
                placeHolder: "Input line number to move to."
            });
            to = parseInt(input)
            if(isNaN(to))
            {
                return;
            }
            if(to < 0 || from == to)
            {
                return;
            }
        }
        else
        {
            const editor = vscode.window.activeTextEditor;
            if(!editor)
            {
                return;
            }
            fsPath = editor.document.uri.fsPath;
            [from, ] = getSelectionLineRange(editor);
            let selection = await vscode.window.showInformationMessage(
                `Move all notes: Select target line and hit OK?`, `OK`, `Cancel`);
            if(selection.toLowerCase() != "ok")
            {
                return
            }
            [to, ] = getSelectionLineRange(editor);
            if(to > editor.document.lineCount || to < 0 || from == to)
            {
                return;
            }
        }

        const line_no = to - from;
        let selection = await vscode.window.showInformationMessage(
            `Move note on ${fsPath} line ${from} and the following lines \
            to line ${to}?`, `Yes`, `No`);
        if(selection.toLowerCase() != "yes")
        {
            return
        }
		let rootPath = vscode.workspace.workspaceFolders[0].uri.fsPath;
		let db = await getDB();
		let relativePath = path.relative(rootPath, fsPath);
		let results = await db.all(
            "SELECT * FROM linenote_notes WHERE fspath = ? and line_no >= ?",
            relativePath, from);
        if (to < from) {
            let check_results = await db.all(
                "SELECT * FROM linenote_notes WHERE fspath = ? and line_no < ?",
                relativePath, from);
            for(let row of results) {
                let check_to  = row.line_no + line_no;
                for(let check_row of check_results)
                {
                    console.info(`${check_row.line_no} = ${check_row.note_content}`);
                    if (check_row.line_no == check_to &&
                        check_row.note_content.toString().trim())
                    {
                        let selection = await vscode.window.showInformationMessage(
                            `Overwrite note on ${fsPath} \
                            line ${check_to}?`, `Yes`, `No`);
                        if(selection.toLowerCase() != "yes")
                        {
                            return
                        }
                    }
                }
            }
        }
		for(let row of results) {
			let from = row.line_no;
			let to  = row.line_no + line_no;
            if (!row.note_content)
            {
                continue
            }
			await db.run(
                "UPDATE linenote_notes SET line_no = ? \
                WHERE fspath = ? AND line_no = ?",
                to, relativePath, from)
		}
		codelensProvider.refresh();
        treeViewProvider.refresh();
		vscode.window.showInformationMessage(
            `Successfully move all notes of ${fsPath} ${line_no>0?"down":"up"} \
            ${Math.abs(line_no)} lines from line ${from}.`)
	}),

    vscode.commands.registerCommand("linenotecodelens.moveSingleNote",
            async (resource?: Entry) => {
        let fsPath:string;
        let from:number;
        let to:number;
        if(resource && (resource.type == LineNoteEntryType.Note ||
            resource.type == LineNoteEntryType.StarNote))
        {
            let rootPath = vscode.workspace.workspaceFolders[0].uri.fsPath;
            fsPath = path.join(rootPath, resource.fspath);
            from = resource.line_no;
            let input = await vscode.window.showInputBox({
                placeHolder: "Input line number to move to."
            });
            to = parseInt(input)
            if(isNaN(to))
            {
                return;
            }
            if(to < 0 || from == to)
            {
                return;
            }
        }
        else
        {
            const editor = vscode.window.activeTextEditor;
            if(!editor)
            {
                return
            }
            [from,] = getSelectionLineRange(editor);
            let selection = await vscode.window.showInformationMessage(
                `Move single note: Select target line and hit OK?`, `OK`, `Cancel`);
            if(selection.toLowerCase() != "ok")
            {
                return
            }
            [to,] = getSelectionLineRange(editor);
            if(to > editor.document.lineCount || to < 0 || from == to)
            {
                return;
            }
            fsPath = editor.document.uri.fsPath;
        }
		var from_url = linenoteScheme + ':' + fsPath + "_L" + from;
		var to_url = linenoteScheme + ':' + fsPath + "_L" + to;
		let source_content = await vscode.workspace.fs.readFile(
            vscode.Uri.parse(from_url));
		if(!source_content.toString())
		{
			return;
		}
		let target_content = await vscode.workspace.fs.readFile(
            vscode.Uri.parse(to_url));
		if(target_content.toString())
		{
			let selection = await vscode.window.showInformationMessage(
                `Overwrite note on line ${to}?`, `Yes`, `No`);
			if(selection.toLowerCase() != "yes")
			{
				return
			}
		}
		console.debug("Move note from " + from_url + " to " + to_url);
		await vscode.workspace.fs.writeFile(
            vscode.Uri.parse(to_url), source_content);
		await vscode.workspace.fs.delete(vscode.Uri.parse(from_url));
		codelensProvider.refresh();
        treeViewProvider.refresh();
		vscode.window.showInformationMessage(
            `Successfully move single note from line ${from} to line ${to}.`)
    }),
    vscode.commands.registerCommand("linenotecodelens.gotoline",
            async (fspath:string, line: number) => {
        if(!fs.statSync(fspath))
        {
            return;
        }
        let uri = vscode.Uri.parse("file://" + fspath);
        await vscode.window.showTextDocument(uri);
        const editor = vscode.window.activeTextEditor;
        if(!editor)
        {
            return
        }
        let range = editor.document.lineAt(line-1).range;
        editor.revealRange(range, vscode.TextEditorRevealType.InCenter);
    }),
    vscode.commands.registerCommand("linenotecodelens.treeview_refresh",
            async () => {
        treeViewProvider.refresh();
    }),
    vscode.commands.registerCommand("linenotecodelens.starNote",
            async (resource?: Entry) => {
        if(resource && (resource.type == LineNoteEntryType.Note ||
                        resource.type == LineNoteEntryType.StarNote))
        {
            let db = await getDB()
            if(!db) {
                return;
            }
            let result = await db.get(
                "SELECT star from linenote_notes WHERE fspath = ? \
                AND line_no = ?",
                resource.fspath,
                resource.line_no
            )
            if(result)
            {
                if(result.star == 1)
                {
                    await db.run(
                        "UPDATE linenote_notes SET star = 0 \
                        WHERE fspath = ? AND line_no = ?",
                        resource.fspath,
                        resource.line_no
                    )
                }
                else
                {
                    await db.run(
                        "UPDATE linenote_notes SET star = 1 \
                        WHERE fspath = ? AND line_no = ?",
                        resource.fspath,
                        resource.line_no
                    )
                }
                treeViewProvider.refresh();
            }
        }
    }),
  );
};

export function deactivate() {
    if (disposables) {
        disposables.forEach(item => item.dispose());
    }
    disposables = [];
}
