import * as vscode from "vscode";
import * as path from "path";
import { linenoteBaseUri } from "./consts";


export const linenoteUrlFromFsPath = (fsPath: string, line_no: number) : vscode.Uri => {
    const projectRoot = vscode.workspace.workspaceFolders[0].uri.fsPath;
    const relativePath = path.relative(projectRoot, fsPath);
    if (!relativePath ||
            relativePath.startsWith("..") ||
            path.isAbsolute(relativePath)) {
        throw Error(`path ${fsPath} is invalid`)
    }
    if (isNaN(line_no)) {
        throw Error(`line number ${line_no} is invalid`)
    }
    return vscode.Uri.parse(linenoteBaseUri + relativePath.split(path.sep).join(path.posix.sep) + "_L" + line_no);
}

export const linenoteFullPath2RelativePath =  (fsPath: string) : string => {
    const projectRoot = vscode.workspace.workspaceFolders[0].uri.fsPath;
    const relativePath = path.relative(projectRoot, fsPath);
    if (!relativePath ||
        relativePath.startsWith("..") ||
        path.isAbsolute(relativePath)) {
       throw Error(`path ${fsPath} is invalid`)
    }
    return relativePath.split(path.sep).join(path.posix.sep);
}

export const linenoteRelativePath2FullPath = (fsPath: string) : string => {
    const projectRoot = vscode.workspace.workspaceFolders[0].uri.fsPath;
    return path.join(projectRoot, fsPath.split(path.posix.sep).join(path.sep));
}
