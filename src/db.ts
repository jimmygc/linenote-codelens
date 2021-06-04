import * as vscode from 'vscode';
import * as sqlite3 from "sqlite3";
import * as sqlite from 'sqlite';
import * as path from "path";
import * as fs from 'fs';

let currentProjectRoot :string;
let db :sqlite.Database;
let initing = false;

export const getDB = async () :Promise<sqlite.Database<sqlite3.Database, sqlite3.Statement>> => {
    let rootPath = vscode.workspace.workspaceFolders[0].uri.fsPath;
    if(initing)
    {
        return null;
    }
	if(rootPath && (!db || currentProjectRoot != rootPath))
	{
        initing = true
		if(db)
		{
			await db.close();
		}
		let db_path = path.join(rootPath, ".vscode", "linenote.db")
		console.info(`db_path = ${db_path}`);
		db = await sqlite.open({
			filename: db_path,
			driver: sqlite3.Database
		})
        let result = await db.get("PRAGMA user_version;")
        console.info("user_version = " + result.user_version);
        let db_version = result.user_version

        result = await db.get(
            "SELECT name FROM sqlite_master \
             WHERE type='table' AND name='linenote_notes';");
        if(!result)
        {
            console.info("creating table linenote_notes");
            await db.exec(" \
            CREATE TABLE linenote_notes ( \
                id INTEGER PRIMARY KEY AUTOINCREMENT, \
                fspath TEXT NOT NULL,  \
                line_no INTEGER NOT NULL, \
                note_content TEXT NOT NULL, \
                star INTEGER \
                );");
            db_version = 1;
        }

        if(db_version == 0)
        {
            console.info("migrate from version 0");
            fs.copyFileSync(db_path, db_path+".bak");
            await db.exec("DROP TABLE IF EXISTS linenote_notes_migrate;");
            await db.exec(" \
                CREATE TABLE IF NOT EXISTS linenote_notes_migrate ( \
                    id INTEGER PRIMARY KEY AUTOINCREMENT, \
                    fspath TEXT NOT NULL,  \
                    line_no INTEGER NOT NULL, \
                    note_content TEXT NOT NULL, \
                    star INTEGER \
                )");
            await db.exec(" \
                INSERT INTO linenote_notes_migrate(fspath, line_no, note_content) \
                SELECT * FROM linenote_notes; \
                ");
            await db.exec("ALTER TABLE linenote_notes RENAME TO \
                           linenote_notes_backup;");
            await db.exec("ALTER TABLE linenote_notes_migrate RENAME TO \
                           linenote_notes;");
        }

        await db.exec("PRAGMA user_version = 1;");
		currentProjectRoot = rootPath;
        initing = false;
	}
	return db;
}
