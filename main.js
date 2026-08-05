const { app, BrowserWindow, ipcMain, dialog, Menu } = require('electron');
const path = require('path');
const fs = require('fs');
const axios = require('axios');
const AdmZip = require('adm-zip');
const { spawn } = require('child_process');

let mainWindow;
let llamaProcess = null;

const baseUserDataDir = app.getPath('userData');
const binDir = path.join(baseUserDataDir, 'bin');
const modelsDir = path.join(baseUserDataDir, 'models');

if (!fs.existsSync(binDir)) fs.mkdirSync(binDir, { recursive: true });
if (!fs.existsSync(modelsDir)) fs.mkdirSync(modelsDir, { recursive: true });

function findExecutable(dir) {
    const exeName = process.platform === 'win32' ? 'llama-server.exe' : 'llama-server';
    
    function searchRecursive(currentDir) {
        try {
            const entries = fs.readdirSync(currentDir, { withFileTypes: true });
            for (let entry of entries) {
                const fullPath = path.join(currentDir, entry.name);
                if (entry.isDirectory()) {
                    const found = searchRecursive(fullPath);
                    if (found) return found;
                } else if (entry.name.toLowerCase() === exeName.toLowerCase()) {
                    return fullPath;
                }
            }
        } catch (e) {}
        return null;
    }

    return searchRecursive(dir);
}

function createWindow() {
    mainWindow = new BrowserWindow({
        width: 1200,
        height: 800,
        frame: true,
        backgroundColor: '#0f172a',
        webPreferences: {
            nodeIntegration: true,
            contextIsolation: false
        }
    });

    Menu.setApplicationMenu(null);

    // llama-server may send X-Frame-Options/CSP headers intended for a
    // top-level browser page. The manager embeds that page in its Web UI tab,
    // so remove only the framing restrictions for the local server.
    mainWindow.webContents.session.webRequest.onHeadersReceived(
        { urls: ['http://127.0.0.1:*/*', 'http://localhost:*/*'] },
        (details, callback) => {
            const headers = { ...details.responseHeaders };
            for (const key of Object.keys(headers)) {
                if (key.toLowerCase() === 'x-frame-options') delete headers[key];
                if (key.toLowerCase() === 'content-security-policy') {
                    headers[key] = headers[key].filter(value =>
                        !/frame-ancestors/i.test(value)
                    );
                    if (headers[key].length === 0) delete headers[key];
                }
            }
            callback({ responseHeaders: headers });
        }
    );

    mainWindow.loadFile('index.html');
}

app.whenReady().then(() => {
    createWindow();

    app.on('activate', () => {
        if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
});

app.on('window-all-closed', () => {
    if (llamaProcess) {
        try { llamaProcess.kill(); } catch(e) {}
    }
    if (process.platform !== 'darwin') app.quit();
});

ipcMain.handle('check-installed', () => {
    const foundPath = findExecutable(binDir);
    return !!foundPath;
});

ipcMain.handle('link-folder-dialog', async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
        properties: ['openDirectory']
    });

    if (!result.canceled && result.filePaths.length > 0) {
        const srcFolder = result.filePaths[0];
        const exeName = process.platform === 'win32' ? 'llama-server.exe' : 'llama-server';
        
        const found = findExecutable(srcFolder);
        if (!found) {
            throw new Error(`Could not find "${exeName}" inside the selected folder.`);
        }

        function copyRecursive(src, dest) {
            if (!fs.existsSync(dest)) fs.mkdirSync(dest, { recursive: true });
            const entries = fs.readdirSync(src, { withFileTypes: true });
            for (let entry of entries) {
                const srcPath = path.join(src, entry.name);
                const destPath = path.join(dest, entry.name);
                if (entry.isDirectory()) {
                    copyRecursive(srcPath, destPath);
                } else {
                    fs.copyFileSync(srcPath, destPath);
                }
            }
        }

        copyRecursive(srcFolder, binDir);
        return true;
    }
    return false;
});

ipcMain.handle('link-models-folder-dialog', async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
        properties: ['openDirectory']
    });

    if (!result.canceled && result.filePaths.length > 0) {
        const srcFolder = result.filePaths[0];
        let count = 0;

        function scanAndSymlink(dir) {
            const entries = fs.readdirSync(dir, { withFileTypes: true });
            for (let entry of entries) {
                const fullPath = path.join(dir, entry.name);
                if (entry.isDirectory()) {
                    scanAndSymlink(fullPath);
                } else if (entry.name.endsWith('.gguf')) {
                    const destPath = path.join(modelsDir, entry.name);
                    if (!fs.existsSync(destPath)) {
                        // Create symlink or copy file if symlink fails
                        try {
                            fs.symlinkSync(fullPath, destPath);
                        } catch (e) {
                            fs.copyFileSync(fullPath, destPath);
                        }
                        count++;
                    }
                }
            }
        }

        scanAndSymlink(srcFolder);
        return count;
    }
    return 0;
});

ipcMain.handle('get-releases', async () => {
    try {
        const response = await axios.get('https://api.github.com/repos/ggerganov/llama.cpp/releases?per_page=5', {
            headers: { 'User-Agent': 'LlamaManager-Electron' }
        });
        return response.data.map(rel => ({
            tag_name: rel.tag_name,
            name: rel.name,
            published_at: rel.published_at,
            assets: rel.assets.map(a => ({ name: a.name, browser_download_url: a.browser_download_url }))
        }));
    } catch (err) {
        throw new Error('Failed to fetch GitHub releases: ' + err.message);
    }
});

ipcMain.handle('download-release', async (event, downloadUrl, fileName) => {
    const zipPath = path.join(binDir, fileName);
    const response = await axios({
        url: downloadUrl,
        method: 'GET',
        responseType: 'stream'
    });

    const writer = fs.createWriteStream(zipPath);
    response.data.pipe(writer);

    return new Promise((resolve, reject) => {
        writer.on('finish', () => {
            try {
                const zip = new AdmZip(zipPath);
                zip.extractAllTo(binDir, true);
                fs.unlinkSync(zipPath);
                resolve(true);
            } catch (e) {
                reject(e);
            }
        });
        writer.on('error', reject);
    });
});

ipcMain.handle('list-models', () => {
    try {
        const files = fs.readdirSync(modelsDir);
        return files.filter(f => f.endsWith('.gguf'));
    } catch (e) {
        return [];
    }
});

ipcMain.handle('select-model-dialog', async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
        properties: ['openFile'],
        filters: [{ name: 'GGUF Models', extensions: ['gguf'] }]
    });
    if (!result.canceled && result.filePaths.length > 0) {
        const srcPath = result.filePaths[0];
        const destPath = path.join(modelsDir, path.basename(srcPath));
        if (srcPath !== destPath) {
            fs.copyFileSync(srcPath, destPath);
        }
        return path.basename(destPath);
    }
    return null;
});

ipcMain.handle('start-server', (event, { modelName, port, ctxSize, gpuLayers, extraArgs }) => {
    if (llamaProcess) {
        throw new Error('Server is already running. Please stop it first.');
    }

    const exePath = findExecutable(binDir);
    let modelPath = path.join(modelsDir, modelName);

    // If model path is a symlink or file, resolve properly
    try {
        if (fs.lstatSync(modelPath).isSymbolicLink()) {
            modelPath = fs.readlinkSync(modelPath);
        }
    } catch (e) {}

    if (!exePath) {
        throw new Error('llama-server executable not found. Please install or link llama.cpp via Backend & Updates tab.');
    }
    if (!fs.existsSync(modelPath)) {
        throw new Error('Selected model file not found.');
    }

    const args = [
        '-m', modelPath,
        '--port', port.toString(),
        '-c', ctxSize.toString(),
        '-ngl', gpuLayers.toString()
    ];

    if (extraArgs && extraArgs.trim().length > 0) {
        args.push(...extraArgs.trim().split(/\s+/));
    }

    const workingDir = path.dirname(exePath);
    console.log('Spawning:', exePath, args.join(' '));

    llamaProcess = spawn(exePath, args, { cwd: workingDir });

    llamaProcess.stdout.on('data', (data) => {
        if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('server-log', data.toString());
        }
    });

    llamaProcess.stderr.on('data', (data) => {
        if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('server-log', data.toString());
        }
    });

    llamaProcess.on('close', (code) => {
        if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('server-log', `\n[Server exited with code ${code}]\n`);
            mainWindow.webContents.send('server-stopped');
        }
        llamaProcess = null;
    });

    return true;
});

ipcMain.handle('stop-server', () => {
    if (llamaProcess) {
        llamaProcess.kill();
        llamaProcess = null;
        return true;
    }
    return false;
});
