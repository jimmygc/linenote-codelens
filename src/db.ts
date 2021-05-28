import * as sqlite3 from "sqlite3";
import * as sqlite from 'sqlite';
import * as path from "path";

let currentProjectRoot :string;
let db :sqlite.Database;

export const getDB = async (rootPath: string) :Promise<sqlite.Database<sqlite3.Database, sqlite3.Statement>> => {
	// console.info(`rootPath = ${rootPath}`);
	if(rootPath && (!db || currentProjectRoot != rootPath))
	{
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
		db.exec(" \
			CREATE TABLE IF NOT EXISTS linenote_notes ( \
				fspath TEXT NOT NULL,  \
				line_no INTEGER NOT NULL, \
				note_content TEXT NOT NULL,\
				PRIMARY KEY(fspath, line_no));");
		currentProjectRoot = rootPath;
	}
	return db;
}
