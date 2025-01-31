import * as vscode from 'vscode';
import * as sqlite from 'sqlite';
import { getDB } from "./db";
import * as path from "path";
import { linenoteRelativePath2FullPath } from "./util"


export enum LineNoteEntryType {
    File = 1,
    Note = 2,
    StarDir = 3,
    StarFolder = 4,
    StarNote = 5
}

export interface Entry {
    fspath: string;
    line_no: number;
    type: LineNoteEntryType;
}

class LineNoteStarDir extends vscode.TreeItem {
    iconPath = {
        light: path.join(__filename, '..', '..', 'resources', 'star.png'),
        dark: path.join(__filename, '..', '..', 'resources', 'star.png')
    };
    contextValue = "star";
}

class LineNoteFile extends vscode.TreeItem {
    iconPath = {
        light: path.join(__filename, '..', '..', 'resources', 'file.png'),
        dark: path.join(__filename, '..', '..', 'resources', 'file.png'),
    };
    contextValue = "file";
}

class LineNoteStarFolder extends vscode.TreeItem {
    iconPath = {
        light: path.join(__filename, '..', '..', 'resources', 'star_folder.png'),
        dark: path.join(__filename, '..', '..', 'resources', 'star_folder.png'),
    };
    contextValue = "star_folder";
}

export class LineNoteEntry extends vscode.TreeItem {
    iconPath = {
        light: path.join(__filename, '..', '..', 'resources', 'bookmark.png'),
        dark: path.join(__filename, '..', '..', 'resources', 'bookmark.png'),
    };
    contextValue = "note";
}

export class LineNoteStarEntry extends vscode.TreeItem {
    iconPath = {
        light: path.join(__filename, '..', '..', 'resources', 'bookmark_star.png'),
        dark: path.join(__filename, '..', '..', 'resources', 'bookmark_star.png'),
    };
    contextValue = "star_note";
}

export class NoteTreeProvider implements vscode.TreeDataProvider<Entry> {
	private db :sqlite.Database;
    private filter : string;
	private _onDidChangeTreeData: vscode.EventEmitter<any> = new vscode.EventEmitter<any>();
	readonly onDidChangeTreeData: vscode.Event<any> = this._onDidChangeTreeData.event;

	private async init(): Promise<void> {
		this.db = await getDB();
	}

    public setFilter(regex: string): void{
        this.filter = regex;
    }

    public resetFilter(): void{
        this.filter = null;
    }

    public refresh(): void {
        this._onDidChangeTreeData.fire(null);
    }

    async getTreeItem(element: Entry): Promise<vscode.TreeItem> {
        await this.init();
        if(!this.db)
        {
            return null;
        }
        let treeItem:vscode.TreeItem = null;
        if(element.type == LineNoteEntryType.File)
        {
            treeItem = new LineNoteFile(
                `${element.fspath.trim()}`,
                vscode.TreeItemCollapsibleState.Collapsed);
        }
        else if (element.type == LineNoteEntryType.StarFolder)
        {
            treeItem = new LineNoteStarFolder(
                `${element.fspath.trim()}`,
                vscode.TreeItemCollapsibleState.Collapsed);
        }
        else if (element.type == LineNoteEntryType.StarDir) {
            treeItem = new LineNoteStarDir(
                `Star notes`,
                vscode.TreeItemCollapsibleState.Expanded);
        }
        else
        {
            let full_path = linenoteRelativePath2FullPath(element.fspath);
            let row = await this.db.get(
                "SELECT * FROM linenote_notes where fspath = ? AND line_no = ?",
                element.fspath, element.line_no);
            if (row && row.note_content.trim()) {
                let txt = row.note_content.trim();
                let label:vscode.TreeItemLabel = {
                    label: `${txt} (L${element.line_no})`
                }
                if(this.filter && this.filter.trim().length)
                {
                    let reg = RegExp(this.filter, "gi");
                    let match = reg.exec(txt);
                    if(!match)
                    {
                        return null;
                    }
                    label.highlights = [[match.index, match.index + match.toString().length]];
                }
                if (row.star == 1)
                {

                    treeItem = new LineNoteStarEntry(
                        label,
                        vscode.TreeItemCollapsibleState.None);
                    treeItem.tooltip = `${element.fspath}:${element.line_no}\n` +
                        `Star folder:${row.star_dir}`;
                }
                else
                {
                    treeItem = new LineNoteEntry(
                        label,
                        vscode.TreeItemCollapsibleState.None);
                    treeItem.tooltip = `${element.fspath}:${element.line_no}`;
                }
                treeItem.command = {
                    title: `${txt} (L${element.line_no})`,
                    command: "linenotecodelens.gotoline",
                    arguments: [full_path, element.line_no]
                };
            }
        }
        return treeItem;
    }

    async getParent(element: Entry): Promise<Entry> {
        await this.init();
        if(!this.db)
        {
            return null;
        }
        if (element.type == LineNoteEntryType.Note)
        {
            return {
                fspath: element.fspath,
                type:LineNoteEntryType.File,
                line_no:0
            };
        }
        else if (element.type == LineNoteEntryType.StarNote)
        {
            return {
                fspath: element.fspath,
                type:LineNoteEntryType.StarFolder,
                line_no:0
            };
        }
        else if (element.type == LineNoteEntryType.StarFolder)
        {
            return {
                fspath: null,
                line_no: 0,
                type: LineNoteEntryType.StarDir
            }
        }
        return null
    }

    async getChildren(element?: Entry): Promise<Entry[]> {
        await this.init();
        if(!this.db)
        {
            return []
        }
        if(!element)
        {
            let children:Entry[] = [];
            children.push(
                {
                    fspath: null,
                    line_no: 0,
                    type: LineNoteEntryType.StarDir
                }
            )

            let results = await this.db.all(
                "SELECT DISTINCT fspath FROM linenote_notes");
            if (results)
            {
                for (let row of results)
                {
                    let e :Entry = {
                        fspath: row.fspath,
                        type:LineNoteEntryType.File,
                        line_no:0
                    };
                    children.push(e)
                }
            }
            return children
        }
        let children:Entry[] = [];
        let results:any[];
        switch(element.type)
        {
            case LineNoteEntryType.StarDir:
                results = await this.db.all(
                    "SELECT DISTINCT star_dir FROM linenote_notes where star = 1");
                if (results)
                {
                    for (let row of results)
                    {
                        if(row.star_dir)
                        {
                            let e :Entry = {
                                fspath: row.star_dir,
                                type:LineNoteEntryType.StarFolder,
                                line_no: 0
                            }
                            children.push(e)
                        }
                    }
                }
                return children;
            case LineNoteEntryType.File:
                results = await this.db.all(
                    "SELECT * FROM linenote_notes where fspath = ?",
                    element.fspath);
                if (results)
                {
                    for (let row of results)
                    {
                        let e :Entry = {
                            fspath: row.fspath,
                            type:LineNoteEntryType.Note,
                            line_no: row.line_no
                        }
                        children.push(e)
                    }
                }
                return children
            case LineNoteEntryType.StarFolder:
                results = await this.db.all(
                    "SELECT * FROM linenote_notes WHERE star = 1 AND star_dir = ?",
                    element.fspath);
                if (results)
                {
                    for (let row of results)
                    {
                        let e :Entry = {
                            fspath: row.fspath,
                            type:LineNoteEntryType.StarNote,
                            line_no: row.line_no
                        }
                        children.push(e)
                    }
                }
                return children;
        }
        return []
    }
}
