import * as vscode from 'vscode';
import * as sqlite from 'sqlite';
import { getDB } from "./db";
import * as path from "path";

export interface Entry {
    fspath: string;
    note: string;
    line_no: number;
    type: vscode.FileType;
    uri: vscode.Uri;
}
class LineNoteFile extends vscode.TreeItem {
    iconPath = {
        light: path.join(__filename, '..', '..', 'resources', 'light', 'document.svg'),
        dark: path.join(__filename, '..', '..', 'resources', 'dark', 'document.svg')
    };
    contextValue = "file";
}

export class LineNoteEntry extends vscode.TreeItem {
    iconPath = {
        light: path.join(__filename, '..', '..', 'resources', 'light', 'string.svg'),
        dark: path.join(__filename, '..', '..', 'resources', 'dark', 'string.svg')
    };
    contextValue = "note";
}

const linenoteScheme = 'linenote';

export class NoteTreeProvider implements vscode.TreeDataProvider<Entry> {
	private db :sqlite.Database;
	public _onDidChangeTreeData: vscode.EventEmitter<any> = new vscode.EventEmitter<any>();
	readonly onDidChangeTreeData: vscode.Event<any> = this._onDidChangeTreeData.event;

	private async init(): Promise<void> {
		this.db = await getDB();
	}

    async getTreeItem(element: Entry): Promise<vscode.TreeItem> {
        let rootPath = vscode.workspace.workspaceFolders[0].uri.fsPath;
        let treeItem:vscode.TreeItem;
        if(element.type == vscode.FileType.Directory)
        {
            treeItem = new LineNoteFile(
                `${element.fspath.trim()}`,
                vscode.TreeItemCollapsibleState.Expanded);
        }
        else
        {
            let full_path = path.join(rootPath, element.fspath);
            treeItem = new LineNoteEntry(
                `${element.note.trim()} (L${element.line_no})`,
                vscode.TreeItemCollapsibleState.None);
            treeItem.command = {
                title: `${element.note.trim()} (L${element.line_no})`,
                command: "linenotecodelens.gotoline",
                arguments: [full_path, element.line_no]
            };
        }
        return treeItem;
    }

    async getChildren(element?: Entry): Promise<Entry[]> {
        await this.init();
        if(!element)
        {
            let children:Entry[] = [];
            let results = await this.db.all("SELECT DISTINCT fspath FROM linenote_notes");
            if (results)
            {
                for (let row of results)
                {
                    let e :Entry = {fspath: row.fspath, type:vscode.FileType.Directory, note:"", line_no:0, uri:null};
                    children.push(e)
                }
            }
            return children
        }
        else if (element.type == vscode.FileType.Directory) {
            let children:Entry[] = [];
            let results = await this.db.all("SELECT * FROM linenote_notes where fspath = ?", element.fspath);
            let rootPath = vscode.workspace.workspaceFolders[0].uri.fsPath;
            if (results)
            {
                for (let row of results)
                {
                    let full_path = path.join(rootPath, row.fspath);
                    let e :Entry = {
                        fspath: row.fspath,
                        type:vscode.FileType.File,
                        line_no: row.line_no,
                        note: row.note_content,
                        uri: vscode.Uri.parse(linenoteScheme + ":/" + full_path + "_L" + row.line_no)};
                    children.push(e)
                }
            }
            return children
        }
        return []
    }
}
