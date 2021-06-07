sqlite_ver=$(npm view sqlite3 version)
node_modules/.bin/node-pre-gyp install --target_platform=win32 --target_arch=ia32 --directory=./node_modules/sqlite3  --target=${sqlite_ver}
node_modules/.bin/node-pre-gyp install --target_platform=win32 --target_arch=x64 --directory=./node_modules/sqlite3  --target=${sqlite_ver}
node_modules/.bin/node-pre-gyp install --target_platform=darwin --target_arch=x64 --directory=./node_modules/sqlite3  --target=${sqlite_ver}
node_modules/.bin/node-pre-gyp install --target_platform=linux --target_arch=x64 --directory=./node_modules/sqlite3  --target=${sqlite_ver}

