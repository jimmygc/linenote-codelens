import * as vscode from "vscode";
import * as sqlite from 'sqlite';
import { CodelensProvider } from './CodelensProvider';
import { NoteTreeProvider, Entry, LineNoteEntryType } from './TreeViewProvider';
import * as path from "path";
import { getDB } from "./db";
import * as fs from 'fs';
import { linenoteScheme } from "./consts"
import { linenoteUrlFromFsPath, linenoteFullPath2RelativePath, linenoteRelativePath2FullPath } from "./util"

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
  await getDB();

  const codelensProvider = new CodelensProvider();
  vscode.languages.registerCodeLensProvider("*", codelensProvider);

  const treeViewProvider = new NoteTreeProvider();
  let treeview = vscode.window.createTreeView(
      'LinenoteExplorer',
      { treeDataProvider: treeViewProvider,
        showCollapseAll: true,
        canSelectMany: true});
  class linenoteFS implements vscode.FileSystemProvider {

	private _emitter = new vscode.EventEmitter<vscode.FileChangeEvent[]>();
	readonly onDidChangeFile: vscode.Event<vscode.FileChangeEvent[]> =
        this._emitter.event;
	private db :sqlite.Database;

	private uri2path_lineno(uri: vscode.Uri) : [string, Number]{
		let relativePath = uri.toString().replace(
            new RegExp("^" + linenoteScheme + ":/"), "");
		let index = relativePath.lastIndexOf("_L");
		if(index == -1) {
			throw new Error(`path ${relativePath} is invalid`)
		}
		let line_no = parseInt(relativePath.slice(index + 2))
		if(isNaN(line_no))
		{
			throw new Error(`${relativePath.slice(index + 2)} is not a number`)
		}
        relativePath = relativePath.slice(0, index);
		return [relativePath, line_no]
	}

	private async init(): Promise<void> {
		this.db = await getDB();
	}


    async stat(uri: vscode.Uri): Promise<vscode.FileStat> {
		return new File(uri.toString());
    }

	async readFile(uri: vscode.Uri): Promise<Uint8Array> {
		let [fsPath, line_no] = this.uri2path_lineno(uri);
		await this.init();
		console.debug(`readFile: ${fsPath}_${line_no}`);
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
		let [fsPath, line_no] = this.uri2path_lineno(uri);
		await this.init();
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
		let [fsPath, line_no] = this.uri2path_lineno(uri);
		await this.init();
		console.debug("deleting file " + fsPath);
		await this.db.run(
            "DELETE FROM linenote_notes WHERE fspath = ? AND line_no = ?",
            fsPath, line_no)
        treeViewProvider.refresh();
	}
	async rename(oldUri: vscode.Uri, newUri: vscode.Uri,
                 options: { overwrite: boolean }): Promise<void> {
		let [from_path, from_lineno] = this.uri2path_lineno(oldUri);
		let [to_path, to_lineno] = this.uri2path_lineno(newUri);
		await this.init();
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
		let fullPath = linenoteRelativePath2FullPath(row.fspath);
        console.debug("autodelete path = " + fullPath);
		if(!fs.existsSync(fullPath)) {
			console.debug(`auto deleted fullPath = ${fullPath}`);
			db.run("DELETE FROM linenote_notes WHERE fspath = ?", row.fspath)
			vscode.window.setStatusBarMessage(
                `Linenote: Auto removed notes of ${row.fspath}.`);
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
            vscode.window.setStatusBarMessage(`Linenote: Auto removed empty note of \
                ${row.fspath}:${row.line_no}.`);
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
        const editor = vscode.window.activeTextEditor;
        if (editor)
        {
            const fsPath = editor.document.uri.fsPath;
            const line_no = e.selections[0].start.line + 1;
            let uri :vscode.Uri;
            try {
                uri = linenoteUrlFromFsPath(fsPath, line_no);
            } catch {
                vscode.commands.executeCommand(
                    'setContext', 'lineNote.showAddNoteCommand', false);
                return;
            }
            vscode.commands.executeCommand(
                'setContext', 'lineNote.showAddNoteCommand', true);
            let content = await vscode.workspace.fs.readFile(uri);
            if(content.toString()) {
                vscode.commands.executeCommand(
                    'setContext', 'lineNote.showModNoteCommand', true);
            }
            else
            {
                vscode.commands.executeCommand(
                    'setContext', 'lineNote.showModNoteCommand', false);
            }
            if (treeview.visible) {
                let relativePath = linenoteFullPath2RelativePath(fsPath);
                // console.debug("on select: relativePath=" + relativePath);
                if(content.toString())
                {
                    // console.debug("on select: reveal relativePath=" + relativePath);
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
            let uri :vscode.Uri;
            try {
                uri = linenoteUrlFromFsPath(full_path, resource.line_no);
            } catch(e)
            {
                vscode.window.showErrorMessage(
                    "Linenote: Only files in the first working folder is supported");
                    return;
            }
            console.log("open node: " + uri);
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
                let uri :vscode.Uri;
                try {
                    uri = linenoteUrlFromFsPath(fsPath, from);
                } catch(e) {
                    vscode.window.showErrorMessage(
                        "Linenote: Only files in the first working folder is supported");
                    return;
                }
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
            let uri :vscode.Uri;
            try {
                uri = linenoteUrlFromFsPath(full_path, resource.line_no);
            } catch(e) {
                return;
            }
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
                let url :vscode.Uri;
                try {
                    url = linenoteUrlFromFsPath(fsPath, from);
                } catch(e) {
                    return;
                }
                let note_content =
                    await vscode.workspace.fs.readFile(url);
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
                    url, {useTrash: false});
                codelensProvider.refresh();
                treeViewProvider.refresh();
                vscode.window.setStatusBarMessage(
                    `Linenote: Successfully remove note from line ${from}.`);
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
		let relativePath = linenoteFullPath2RelativePath(fsPath);
		let db = await getDB();
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
            await db.run("BEGIN TRANSACTION;");
            try {
                await db.run(
                    "UPDATE linenote_notes SET line_no = ? \
                    WHERE fspath = ? AND line_no = ?",
                    to, relativePath, from)
            } catch (e) {
                await db.run("ROLLBACK;");
                vscode.window.showErrorMessage("failed to write db");
                return;
            }
            await db.run("COMMIT;");
		}
		codelensProvider.refresh();
        treeViewProvider.refresh();
		vscode.window.setStatusBarMessage(
            `Linenote: Successfully move all notes of ${fsPath} ${line_no>0?"down":"up"} \
            ${Math.abs(line_no)} lines from line ${from}.`);
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
		let db = await getDB();
		let relativePath = linenoteFullPath2RelativePath(fsPath);
        await db.run(
            "UPDATE linenote_notes SET line_no = ? \
            WHERE fspath = ? AND line_no = ?",
            to, relativePath, from)
		codelensProvider.refresh();
        treeViewProvider.refresh();
		vscode.window.setStatusBarMessage(
            `Linenote: Successfully move single note from line ${from} to line ${to}.`);
    }),
    vscode.commands.registerCommand("linenotecodelens.gotoline",
            async (fspath:string, line: number) => {
        console.debug("goto line fspath=" + fspath);
        if(!fs.statSync(fspath))
        {
            return;
        }

        let uri = vscode.Uri.parse(
            (fspath.startsWith("/") ? "file://": "file:/") + fspath);
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
                        "UPDATE linenote_notes SET star = 0, star_dir = '' \
                        WHERE fspath = ? AND line_no = ?",
                        resource.fspath,
                        resource.line_no
                    )
                }
                else
                {
                    let items :string[] = [];
                    let results = await db.all(
                        "SELECT DISTINCT star_dir from linenote_notes;"
                    );
                    if(results)
                    {
                        for (let row of results)
                        {
                            if(row.star_dir)
                            {
                                items.push(row.star_dir);
                            }
                        }

                    }
                    let star_dir :string;
                    if(items.length)
                    {
                        let qp_items = []
                        qp_items.push("Linenote: Create new star dir.");
                        qp_items = qp_items.concat(items);
                        star_dir = await vscode.window.showQuickPick(
                            qp_items,
                            {placeHolder: "Choose star dir name for the note.", });
                    }
                    if(!star_dir || star_dir == "Linenote: Create new star dir.")
                    {
                        star_dir = await vscode.window.showInputBox(
                            {placeHolder: "Input star dir name for the note." })
                    }
                    if(!star_dir || star_dir == "Linenote: Create new star dir.")
                    {
                        return;
                    }
                    await db.run(
                        "UPDATE linenote_notes SET star = 1, star_dir = ? \
                        WHERE fspath = ? AND line_no = ?",
                        star_dir,
                        resource.fspath,
                        resource.line_no
                    )
                }
                treeViewProvider.refresh();
            }
        }
    }),
    vscode.commands.registerCommand("linenotecodelens.unstarNote",
            async (resource?: Entry) => {
        vscode.commands.executeCommand("linenotecodelens.starNote", resource);
    }),
    vscode.commands.registerCommand("linenotecodelens.renameStarFolder",
    async (resource?: Entry) => {
        if(resource && resource.type == LineNoteEntryType.StarFolder)
        {
            let star_dir = await vscode.window.showInputBox(
                {placeHolder: "Input new star dir name." });
            if(!star_dir || star_dir == resource.fspath)
            {
                return;
            }
            let db = await getDB();

            let results = await db.all(
                "SELECT DISTINCT star_dir from linenote_notes WHERE star_dir = ?",
                star_dir
            );

            if(results.length)
            {
                vscode.window.showErrorMessage("Star folder name confiict.");
                return;
            }

            await db.run("BEGIN TRANSACTION;");
            try {
                await db.run(
                    "UPDATE linenote_notes SET star_dir = ? \
                    WHERE star_dir = ?",
                    star_dir, resource.fspath);
            } catch (e) {
                await db.run("ROLLBACK;");
                vscode.window.showErrorMessage("failed to write db");
                return;
            }
            await db.run("COMMIT;");
            treeViewProvider.refresh();
        }
    }),
    vscode.commands.registerCommand("linenotecodelens.unstarNoteTreeViewSelect",
    async () => {
        let selected_notes : Entry[] = [];
        for(let element of treeview.selection)
        {
            if(element && (element.type == LineNoteEntryType.Note ||
                element.type == LineNoteEntryType.StarNote))
            {
                selected_notes.push(element);
            }
        }

        if(!selected_notes.length)
        {
            return;
        }
        let db = await getDB();
        await db.run("BEGIN TRANSACTION;");
        try{
            for (let note of selected_notes)
            {
                await db.run(
                    "UPDATE linenote_notes SET star = 0, star_dir = '' \
                    WHERE fspath = ? AND line_no = ?",
                    note.fspath,
                    note.line_no
                );
            }
        } catch (e) {
            await db.run("ROLLBACK;");
            vscode.window.showErrorMessage("failed to write db");
            return;
        }
        await db.run("COMMIT;");
        treeViewProvider.refresh();
    }),
    vscode.commands.registerCommand("linenotecodelens.starNoteTreeViewSelect",
    async () => {
        let selected_notes : Entry[] = [];
        for(let element of treeview.selection)
        {
            if(element && (element.type == LineNoteEntryType.Note ||
                element.type == LineNoteEntryType.StarNote))
            {
                selected_notes.push(element);
            }
        }

        if(!selected_notes.length)
        {
            return;
        }

        let db = await getDB();
        let items :string[] = [];
        let results = await db.all(
            "SELECT DISTINCT star_dir from linenote_notes;"
        );
        if(results)
        {
            for (let row of results)
            {
                if(row.star_dir)
                {
                    items.push(row.star_dir);
                }
            }

        }
        let star_dir :string;
        if(items.length)
        {
            let qp_items = []
            qp_items.push("Linenote: Create new star dir.");
            qp_items = qp_items.concat(items);
            star_dir = await vscode.window.showQuickPick(
                qp_items,
                {placeHolder: "Choose star dir name for the note.", });
        }
        if(!star_dir || star_dir == "Linenote: Create new star dir.")
        {
            star_dir = await vscode.window.showInputBox(
                {placeHolder: "Input star dir name for the note." })
        }
        if(!star_dir || star_dir == "Linenote: Create new star dir.")
        {
            return;
        }
        // update all notes
        await db.run("BEGIN TRANSACTION;");
        try{
            for (let note of selected_notes)
            {
                await db.run(
                    "UPDATE linenote_notes SET star = 1, star_dir = ? \
                    WHERE fspath = ? AND line_no = ?",
                    star_dir,
                    note.fspath,
                    note.line_no
                );
            }
        } catch (e) {
            await db.run("ROLLBACK;");
            vscode.window.showErrorMessage("failed to write db");
            return;
        }
        await db.run("COMMIT;");
        treeViewProvider.refresh();
    }),

  );
};

export function deactivate() {
    if (disposables) {
        disposables.forEach(item => item.dispose());
    }
    disposables = [];
}
