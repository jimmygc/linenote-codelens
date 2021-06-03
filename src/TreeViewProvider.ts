import * as vscode from 'vscode';
import * as sqlite from 'sqlite';
import { getDB } from "./db";
import * as path from "path";

export interface Entry {
    fspath: string;
    line_no: number;
    type: vscode.FileType;
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
                vscode.TreeItemCollapsibleState.Collapsed);
        }
        else
        {
            let full_path = path.join(rootPath, element.fspath);
            let row = await this.db.get("SELECT * FROM linenote_notes where fspath = ? AND line_no = ?", element.fspath, element.line_no);
            if (row) {
                treeItem = new LineNoteEntry(
                    `${row.note_content.trim()} (L${element.line_no})`,
                    vscode.TreeItemCollapsibleState.None);
                treeItem.command = {
                    title: `${row.note_content.trim()} (L${element.line_no})`,
                    command: "linenotecodelens.gotoline",
                    arguments: [full_path, element.line_no]
                };
            }
        }
        return treeItem;
    }

    async getParent(element: Entry): Promise<Entry> {
        if (element.type == vscode.FileType.File)
        {
            return {fspath: element.fspath, type:vscode.FileType.Directory, line_no:0};
        }
        return null
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
                    let e :Entry = {fspath: row.fspath, type:vscode.FileType.Directory, line_no:0};
                    children.push(e)
                }
            }
            return children
        }
        else if (element.type == vscode.FileType.Directory) {
            let children:Entry[] = [];
            let results = await this.db.all("SELECT * FROM linenote_notes where fspath = ?", element.fspath);
            if (results)
            {
                for (let row of results)
                {
                    let e :Entry = {
                        fspath: row.fspath,
                        type:vscode.FileType.File,
                        line_no: row.line_no
                    }
                    children.push(e)
                }
            }
            return children
        }
        return []
    }
}
