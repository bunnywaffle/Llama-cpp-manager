const { app, BrowserWindow, ipcMain, dialog, Menu, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const axios = require('axios');
const AdmZip = require('adm-zip');
const { spawn } = require('child_process');

let mainWindow;
let llamaProcess = null;
let serverStarting = false;

// ============ Self-Contained Data Directory Resolver ============
const configFilePath = path.join(app.getPath('appData'), 'llama-manager-location.json');

function resolveDefaultDataDir() {
    // 1. If user previously chose a custom folder, use it.
    try {
        if (fs.existsSync(configFilePath)) {
            const raw = fs.readFileSync(configFilePath, 'utf8');
            const parsed = JSON.parse(raw);
            if (parsed.dataDir && fs.existsSync(parsed.dataDir)) {
                return parsed.dataDir;
            }
        }
    } catch (e) {}

    // 2. If running as portable Windows executable, keep all data right in the executable's folder/llama-manager-data
    if (process.env.PORTABLE_EXECUTABLE_DIR) {
        const portableData = path.join(process.env.PORTABLE_EXECUTABLE_DIR, 'llama-manager-data');
        return portableData;
    }

    // 3. Fallback to standard user data directory
    return app.getPath('userData');
}

let activeDataDir = resolveDefaultDataDir();

function getDataDir() {
    if (!fs.existsSync(activeDataDir)) {
        try { fs.mkdirSync(activeDataDir, { recursive: true }); } catch (e) {}
    }
    return activeDataDir;
}

function getBinDir() {
    const dir = path.join(getDataDir(), 'bin');
    if (!fs.existsSync(dir)) try { fs.mkdirSync(dir, { recursive: true }); } catch (e) {}
    return dir;
}

function getModelsDir() {
    const dir = path.join(getDataDir(), 'models');
    if (!fs.existsSync(dir)) try { fs.mkdirSync(dir, { recursive: true }); } catch (e) {}
    return dir;
}

function getSettingsPath() { return path.join(getDataDir(), 'settings.json'); }
function getPersonasPath() { return path.join(getDataDir(), 'personas.json'); }
function getModelsMetaPath() { return path.join(getDataDir(), 'models-meta.json'); }

const DEFAULT_SETTINGS = {
    port: 8080,
    ctxSize: 8192,
    gpuLayers: 99,
    extraArgs: '',
    model: '',
    theme: 'dark',
    temperature: 0.8,
    topK: 40,
    topP: 0.95,
    repeatPenalty: 1.1,
    minP: 0.05,
    reasoningEffort: 'medium'
};

function getSettings() {
    try {
        const raw = fs.readFileSync(getSettingsPath(), 'utf8');
        return { ...DEFAULT_SETTINGS, ...JSON.parse(raw) };
    } catch (e) {
        return { ...DEFAULT_SETTINGS };
    }
}

function saveSettings(settings) {
    const merged = { ...getSettings(), ...(settings || {}) };
    fs.writeFileSync(getSettingsPath(), JSON.stringify(merged, null, 2));
    return merged;
}

const DEFAULT_PERSONAS = [
    { id: 'general', name: 'General Assistant', systemPrompt: 'You are a helpful, accurate, and concise assistant.' },
    { id: 'coder', name: 'Coding Expert', systemPrompt: 'You are an expert software engineer. Provide clean, idiomatic code with short explanations. Use fenced code blocks with language tags.' },
    { id: 'writer', name: 'Creative Writer', systemPrompt: 'You are a creative writer with a vivid, engaging style.' }
];

function readPersonas() {
    try {
        const raw = fs.readFileSync(getPersonasPath(), 'utf8');
        const parsed = JSON.parse(raw);
        return Array.isArray(parsed) ? parsed : DEFAULT_PERSONAS;
    } catch (e) {
        return DEFAULT_PERSONAS;
    }
}

function writePersonas(list) {
    fs.writeFileSync(getPersonasPath(), JSON.stringify(list, null, 2));
}

function readModelsMeta() {
    try {
        const raw = fs.readFileSync(getModelsMetaPath(), 'utf8');
        return JSON.parse(raw) || {};
    } catch (e) {
        return {};
    }
}

function writeModelsMeta(meta) {
    fs.writeFileSync(getModelsMetaPath(), JSON.stringify(meta || {}, null, 2));
}

const GGUF_TYPES = {
    UINT8: 0, INT8: 1, UINT16: 2, INT16: 3, UINT32: 4, INT32: 5,
    FLOAT32: 6, BOOL: 7, STRING: 8, ARRAY: 9, UINT64: 10, INT64: 11, FLOAT64: 12
};

function readGgufContextLength(filePath) {
    let fd;
    try {
        fd = fs.openSync(filePath, 'r');
        let buf = Buffer.alloc(0);
        let offset = 0;

        const readBytes = (n) => {
            while (buf.length < offset + n) {
                const chunk = Buffer.alloc(Math.max(n, 8192));
                const bytesRead = fs.readSync(fd, chunk, 0, chunk.length, buf.length);
                if (bytesRead === 0) throw new Error('Unexpected end of GGUF file');
                buf = Buffer.concat([buf, chunk.subarray(0, bytesRead)]);
            }
            const val = buf.subarray(offset, offset + n);
            offset += n;
            return val;
        };

        const readString = () => {
            const len = Number(readBytes(8).readBigUInt64LE(0));
            return readBytes(len).toString('utf8');
        };

        const readValue = (type) => {
            switch (type) {
                case GGUF_TYPES.UINT8: return readBytes(1).readUInt8(0);
                case GGUF_TYPES.INT8: return readBytes(1).readInt8(0);
                case GGUF_TYPES.UINT16: return readBytes(2).readUInt16LE(0);
                case GGUF_TYPES.INT16: return readBytes(2).readInt16LE(0);
                case GGUF_TYPES.UINT32: return readBytes(4).readUInt32LE(0);
                case GGUF_TYPES.INT32: return readBytes(4).readInt32LE(0);
                case GGUF_TYPES.FLOAT32: return readBytes(4).readFloatLE(0);
                case GGUF_TYPES.BOOL: return readBytes(1).readUInt8(0) !== 0;
                case GGUF_TYPES.STRING: return readString();
                case GGUF_TYPES.UINT64: return Number(readBytes(8).readBigUInt64LE(0));
                case GGUF_TYPES.INT64: return Number(readBytes(8).readBigInt64LE(0));
                case GGUF_TYPES.FLOAT64: return readBytes(8).readDoubleLE(0);
                case GGUF_TYPES.ARRAY: {
                    const elemType = readBytes(4).readUInt32LE(0);
                    const n = Number(readBytes(8).readBigUInt64LE(0));
                    const arr = [];
                    for (let i = 0; i < n; i++) arr.push(readValue(elemType));
                    return arr;
                }
                default: throw new Error('Unknown GGUF value type: ' + type);
            }
        };

        if (readBytes(4).toString('ascii') !== 'GGUF') return null;
        readBytes(4);
        readBytes(8);
        const kvCount = Number(readBytes(8).readBigUInt64LE(0));

        for (let i = 0; i < kvCount; i++) {
            const key = readString();
            const type = readBytes(4).readUInt32LE(0);
            const value = readValue(type);
            if (key === 'llama.context_length' || key === 'context_length') {
                return Number(value) > 0 ? Number(value) : null;
            }
        }
        return null;
    } catch (e) {
        return null;
    } finally {
        if (fd !== undefined) {
            try { fs.closeSync(fd); } catch (e) {}
        }
    }
}

function findExecutable(dir) {
    const exeNames = process.platform === 'win32'
        ? ['llama-server.exe', 'server.exe']
        : ['llama-server', 'server'];
    
    function searchRecursive(currentDir, depth = 0) {
        if (!currentDir || depth > 5) return null;
        try {
            if (!fs.existsSync(currentDir)) return null;
            const entries = fs.readdirSync(currentDir, { withFileTypes: true });
            for (let entry of entries) {
                const fullPath = path.join(currentDir, entry.name);
                if (entry.isDirectory()) {
                    const found = searchRecursive(fullPath, depth + 1);
                    if (found) return found;
                } else if (exeNames.some(name => entry.name.toLowerCase() === name.toLowerCase())) {
                    return fullPath;
                }
            }
        } catch (e) {}
        return null;
    }

    const searchDirs = [
        dir,
        getBinDir(),
        path.join(app.getPath('userData'), 'bin'),
        path.join(app.getPath('appData'), 'llama-manager', 'bin'),
        process.cwd(),
        path.join(process.cwd(), 'bin'),
        process.env.PORTABLE_EXECUTABLE_DIR ? path.join(process.env.PORTABLE_EXECUTABLE_DIR, 'bin') : null,
        process.env.PORTABLE_EXECUTABLE_DIR ? path.join(process.env.PORTABLE_EXECUTABLE_DIR, 'llama-manager-data', 'bin') : null
    ].filter(Boolean);

    for (const d of searchDirs) {
        const found = searchRecursive(d);
        if (found) {
            // If found in a fallback location and getBinDir() is different and empty, auto-copy files over
            const targetBin = getBinDir();
            if (targetBin && !searchRecursive(targetBin)) {
                try {
                    const srcDir = path.dirname(found);
                    const files = fs.readdirSync(srcDir);
                    for (const f of files) {
                        const s = path.join(srcDir, f);
                        const dst = path.join(targetBin, f);
                        if (!fs.existsSync(dst) && fs.statSync(s).isFile()) {
                            try { fs.copyFileSync(s, dst); } catch(e) {}
                        }
                    }
                    const syncedExe = searchRecursive(targetBin);
                    if (syncedExe) return syncedExe;
                } catch(err) {}
            }
            return found;
        }
    }
    return null;
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

// ============ Storage & Data Directory IPC Handlers ============
ipcMain.handle('get-data-directory', () => {
    return getDataDir();
});

ipcMain.handle('select-data-directory-dialog', async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
        title: 'Select App Storage & Data Folder',
        properties: ['openDirectory', 'createDirectory']
    });

    if (!result.canceled && result.filePaths.length > 0) {
        const newDir = result.filePaths[0];
        try {
            if (!fs.existsSync(newDir)) fs.mkdirSync(newDir, { recursive: true });
            activeDataDir = newDir;
            fs.writeFileSync(configFilePath, JSON.stringify({ dataDir: newDir }, null, 2));

            // Ensure standard subfolders exist
            getBinDir();
            getModelsDir();

            return activeDataDir;
        } catch (e) {
            throw new Error('Failed to set data directory: ' + e.message);
        }
    }
    return null;
});

ipcMain.handle('open-data-directory', () => {
    shell.openPath(getDataDir());
    return true;
});

// ============ Vision Adapter (mmproj) IPC Handlers ============
ipcMain.handle('get-models-meta', () => {
    return readModelsMeta();
});

ipcMain.handle('link-mmproj-dialog', async (event, modelName) => {
    if (!modelName) throw new Error('No model name specified.');
    const result = await dialog.showOpenDialog(mainWindow, {
        title: 'Select Vision Projector (mmproj) for ' + modelName,
        properties: ['openFile'],
        filters: [{ name: 'GGUF Vision Projector', extensions: ['gguf'] }, { name: 'All Files', extensions: ['*'] }]
    });

    if (!result.canceled && result.filePaths.length > 0) {
        const srcPath = result.filePaths[0];
        const destPath = path.join(getModelsDir(), path.basename(srcPath));
        if (srcPath !== destPath && !fs.existsSync(destPath)) {
            try {
                fs.symlinkSync(srcPath, destPath, 'file');
            } catch (e) {
                try { fs.copyFileSync(srcPath, destPath); } catch (err) {}
            }
        }
        const meta = readModelsMeta();
        meta[modelName] = meta[modelName] || {};
        meta[modelName].mmproj = path.basename(destPath);
        meta[modelName].mmprojFullPath = srcPath;
        writeModelsMeta(meta);
        return meta;
    }
    return null;
});

ipcMain.handle('unlink-mmproj', (event, modelName) => {
    if (!modelName) return;
    const meta = readModelsMeta();
    if (meta[modelName]) {
        delete meta[modelName].mmproj;
        delete meta[modelName].mmprojFullPath;
        writeModelsMeta(meta);
    }
    return meta;
});

// ============ Backend & Models ============
ipcMain.handle('check-installed', () => {
    const foundPath = findExecutable(getBinDir());
    return !!foundPath;
});

function cleanBinDir() {
    if (llamaProcess) {
        try { llamaProcess.kill(); } catch (e) {}
        llamaProcess = null;
        serverStarting = false;
    }
    const binDir = getBinDir();
    if (!fs.existsSync(binDir)) {
        try { fs.mkdirSync(binDir, { recursive: true }); } catch (e) {}
        return;
    }
    const entries = fs.readdirSync(binDir);
    for (const entry of entries) {
        const fullPath = path.join(binDir, entry);
        try {
            const st = fs.lstatSync(fullPath);
            if (st.isDirectory()) {
                fs.rmSync(fullPath, { recursive: true, force: true });
            } else {
                fs.unlinkSync(fullPath);
            }
        } catch (e) {
            console.error('Error removing old bin item:', fullPath, e.message);
        }
    }
}

ipcMain.handle('link-folder-dialog', async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
        title: 'Select llama.cpp Folder (Will replace existing backend)',
        properties: ['openDirectory']
    });

    if (!result.canceled && result.filePaths.length > 0) {
        const srcFolder = result.filePaths[0];
        const found = findExecutable(srcFolder);
        if (!found) {
            throw new Error('Could not find "llama-server" or "server" executable inside the selected folder.');
        }

        // Clean out existing backend binaries first to ensure clean state
        cleanBinDir();

        function copyRecursive(src, dest) {
            if (!fs.existsSync(dest)) fs.mkdirSync(dest, { recursive: true });
            const entries = fs.readdirSync(src, { withFileTypes: true });
            for (let entry of entries) {
                const srcPath = path.join(src, entry.name);
                const destPath = path.join(dest, entry.name);
                if (entry.isDirectory()) {
                    copyRecursive(srcPath, destPath);
                } else {
                    try {
                        fs.copyFileSync(srcPath, destPath);
                    } catch (e) {
                        console.error('Error copying file:', srcPath, e);
                    }
                }
            }
        }

        copyRecursive(srcFolder, getBinDir());
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

        function scanAndSymlink(dir, depth = 0) {
            if (depth > 5) return;
            try {
                const entries = fs.readdirSync(dir, { withFileTypes: true });
                for (let entry of entries) {
                    const fullPath = path.join(dir, entry.name);
                    if (entry.isDirectory()) {
                        scanAndSymlink(fullPath, depth + 1);
                    } else if (entry.name.toLowerCase().endsWith('.gguf')) {
                        const destPath = path.join(getModelsDir(), entry.name);
                        if (!fs.existsSync(destPath)) {
                            try {
                                fs.symlinkSync(fullPath, destPath, 'file');
                                count++;
                            } catch (e) {
                                try {
                                    fs.copyFileSync(fullPath, destPath);
                                    count++;
                                } catch (e2) {}
                            }
                            try {
                                const ctx = readGgufContextLength(fullPath) || 40000;
                                const meta = readModelsMeta();
                                meta[entry.name] = meta[entry.name] || {};
                                meta[entry.name].ctxLength = ctx;
                                writeModelsMeta(meta);
                            } catch (err) {}
                        }
                    }
                }
            } catch (e) {}
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
    const tempZipPath = path.join(getDataDir(), 'temp_release_' + Date.now() + '.zip');
    const response = await axios({
        url: downloadUrl,
        method: 'GET',
        responseType: 'stream'
    });

    const writer = fs.createWriteStream(tempZipPath);
    response.data.pipe(writer);

    return new Promise((resolve, reject) => {
        writer.on('finish', () => {
            try {
                // Wipe out existing old backend files before extracting new release
                cleanBinDir();

                const zip = new AdmZip(tempZipPath);
                zip.extractAllTo(getBinDir(), true);
                try { fs.unlinkSync(tempZipPath); } catch (err) {}
                resolve(true);
            } catch (e) {
                try { fs.unlinkSync(tempZipPath); } catch (err) {}
                reject(e);
            }
        });
        writer.on('error', (err) => {
            try { fs.unlinkSync(tempZipPath); } catch (e) {}
            reject(err);
        });
    });
});

ipcMain.handle('list-models', () => {
    try {
        const modelsDir = getModelsDir();
        const files = fs.readdirSync(modelsDir);
        return files.filter(f => {
            if (!f.toLowerCase().endsWith('.gguf')) return false;
            const fullPath = path.join(modelsDir, f);
            try {
                return fs.existsSync(fullPath);
            } catch (e) {
                return false;
            }
        });
    } catch (e) {
        return [];
    }
});

ipcMain.handle('delete-model', (event, modelName) => {
    if (!modelName || path.basename(modelName) !== modelName) {
        throw new Error('Invalid model name.');
    }
    const modelPath = path.join(getModelsDir(), modelName);
    if (!fs.existsSync(modelPath)) {
        throw new Error('Model file not found.');
    }
    if (llamaProcess) {
        throw new Error('Stop the server before removing a model.');
    }
    try {
        const st = fs.lstatSync(modelPath);
        if (st.isSymbolicLink()) {
            fs.unlinkSync(modelPath);
        } else if (st.isFile()) {
            fs.unlinkSync(modelPath);
        } else {
            throw new Error('Not a regular file.');
        }
    } catch (e) {
        if (e.code === 'EPERM') throw new Error('Failed to remove model (permission denied).');
        throw new Error('Failed to remove model: ' + e.message);
    }
    return true;
});

ipcMain.handle('get-model-ctx', (event, modelName) => {
    if (!modelName || path.basename(modelName) !== modelName) return 40000;
    const meta = readModelsMeta();
    if (meta[modelName] && meta[modelName].ctxLength) {
        return meta[modelName].ctxLength;
    }
    let modelPath = path.join(getModelsDir(), modelName);
    try {
        modelPath = fs.realpathSync(modelPath);
    } catch (e) {}
    if (!fs.existsSync(modelPath)) return 40000;
    try {
        const detected = readGgufContextLength(modelPath) || 40000;
        meta[modelName] = meta[modelName] || {};
        meta[modelName].ctxLength = detected;
        writeModelsMeta(meta);
        return detected;
    } catch (e) {
        return 40000;
    }
});

ipcMain.handle('get-settings', () => getSettings());
ipcMain.handle('save-settings', (event, settings) => saveSettings(settings || {}));
ipcMain.handle('list-personas', () => readPersonas());

ipcMain.handle('save-persona', (event, persona) => {
    if (!persona || typeof persona !== 'object') throw new Error('Invalid persona.');
    const list = readPersonas();
    if (persona.id) {
        const idx = list.findIndex(p => p.id === persona.id);
        if (idx >= 0) list[idx] = persona;
        else list.push(persona);
    } else {
        persona.id = 'p_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
        list.push(persona);
    }
    writePersonas(list);
    return list;
});

ipcMain.handle('delete-persona', (event, id) => {
    let list = readPersonas();
    list = list.filter(p => p.id !== id);
    writePersonas(list);
    return list;
});

let chatStream = null;

ipcMain.on('chat-start', (event, payload) => {
    const { port = 8080, messages, params } = payload || {};
    if (!messages || !Array.isArray(messages) || messages.length === 0) {
        event.sender.send('chat-error', { message: 'No messages to send.' });
        return;
    }

    if (chatStream) {
        try { chatStream.destroy(); } catch (e) {}
        chatStream = null;
    }

    const url = 'http://127.0.0.1:' + port + '/v1/chat/completions';

    const body = {
        model: 'local-model',
        messages,
        stream: true,
        temperature: (params && params.temperature !== undefined) ? params.temperature : 0.8,
        top_p: (params && params.topP !== undefined) ? params.topP : 0.95,
        top_k: (params && params.topK !== undefined) ? params.topK : 40,
        min_p: (params && params.minP !== undefined) ? params.minP : 0.05,
        repeat_penalty: (params && params.repeatPenalty !== undefined) ? params.repeatPenalty : 1.1,
        max_tokens: (params && params.maxTokensUnlimited)
            ? -1
            : ((params && params.maxTokens !== undefined) ? params.maxTokens : 2048),
        reasoning_effort: (params && params.reasoningEffort && params.reasoningEffort !== 'none')
            ? params.reasoningEffort
            : undefined
    };

    axios.post(url, body, {
        responseType: 'stream',
        headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
        timeout: 0
    }).then(response => {
        chatStream = response.data;
        let buffer = '';

        const sendChatError = (message) => {
            if (!event.sender.isDestroyed()) event.sender.send('chat-error', { message });
        };

        chatStream.on('data', (chunk) => {
            buffer += chunk.toString('utf8');
            const lines = buffer.split('\n');
            buffer = lines.pop();

            for (const line of lines) {
                const trimmed = line.trim();
                if (!trimmed.startsWith('data:')) continue;
                const data = trimmed.slice(5).trim();
                if (data === '[DONE]') continue;
                try {
                    const json = JSON.parse(data);
                    const choice = json.choices && json.choices[0] && json.choices[0].delta;
                    if (!choice || event.sender.isDestroyed()) continue;
                    const delta = choice.content || '';
                    const reasoning = choice.reasoning_content || '';
                    if (delta || reasoning) {
                        event.sender.send('chat-chunk', { delta, reasoning });
                    }
                } catch (e) {}
            }
        });

        chatStream.on('end', () => {
            chatStream = null;
            if (!event.sender.isDestroyed()) event.sender.send('chat-done', {});
        });

        chatStream.on('error', (err) => {
            chatStream = null;
            sendChatError(err.message || 'Stream error');
        });

        chatStream.on('close', () => {
            chatStream = null;
            if (!event.sender.isDestroyed()) event.sender.send('chat-done', {});
        });
    }).catch(err => {
        if (err.response && err.response.data && typeof err.response.data.on === 'function') {
            let errBody = '';
            err.response.data.on('data', chunk => { errBody += chunk.toString('utf8'); });
            err.response.data.on('end', () => {
                let parsedMsg = '';
                try {
                    const parsed = JSON.parse(errBody);
                    parsedMsg = (parsed.error && (parsed.error.message || parsed.error)) || errBody;
                } catch (e) {
                    parsedMsg = errBody;
                }
                if (!event.sender.isDestroyed()) event.sender.send('chat-error', { message: parsedMsg || err.message || 'Vision model error' });
            });
        } else {
            const msg = err.response && err.response.data && err.response.data.error
                ? (err.response.data.error.message || err.response.data.error)
                : err.message;
            if (!event.sender.isDestroyed()) event.sender.send('chat-error', { message: msg || 'Failed to connect to the server.' });
        }
    });
});

ipcMain.on('chat-stop', () => {
    if (chatStream) {
        try { chatStream.destroy(); } catch (e) {}
        chatStream = null;
    }
});

ipcMain.handle('select-model-dialog', async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
        title: 'Select GGUF Model File',
        properties: ['openFile'],
        filters: [{ name: 'GGUF Models', extensions: ['gguf'] }, { name: 'All Files', extensions: ['*'] }]
    });
    if (!result.canceled && result.filePaths.length > 0) {
        const srcPath = result.filePaths[0];
        const fileName = path.basename(srcPath);
        const destPath = path.join(getModelsDir(), fileName);
        if (srcPath !== destPath) {
            if (!fs.existsSync(destPath)) {
                try {
                    fs.symlinkSync(srcPath, destPath, 'file');
                } catch (e) {
                    try {
                        fs.copyFileSync(srcPath, destPath);
                    } catch (err) {
                        throw new Error('Could not link or copy model file: ' + err.message);
                    }
                }
            }
        }
        
        // Immediately detect and cache context length in models-meta.json on import
        try {
            const ctx = readGgufContextLength(srcPath) || 40000;
            const meta = readModelsMeta();
            meta[fileName] = meta[fileName] || {};
            meta[fileName].ctxLength = ctx;
            writeModelsMeta(meta);
        } catch (e) {}

        return fileName;
    }
    return null;
});

function splitCommandLine(value) {
    const args = [];
    const pattern = /(?:[^\s"']+|"[^"]*"|'[^']*')+/g;
    for (const item of value.match(pattern) || []) args.push(item.replace(/^("|')|("|')$/g, ''));
    return args;
}

async function waitForServer(port, child, getRecentLogs, timeoutMs = 45000) {
    const healthUrl = 'http://127.0.0.1:' + port + '/health';
    const propsUrl = 'http://127.0.0.1:' + port + '/props';
    const rootUrl = 'http://127.0.0.1:' + port + '/';
    const startedAt = Date.now();
    let lastError = '';
    while (Date.now() - startedAt < timeoutMs) {
        if (!child || child.exitCode !== null || child.killed) {
            const logs = getRecentLogs ? getRecentLogs() : '';
            const errorDetail = logs ? '\n\nLog output:\n' + logs : '';
            throw new Error((lastError || 'llama-server exited unexpectedly before becoming ready.') + errorDetail);
        }
        try {
            const response = await axios.get(healthUrl, { timeout: 1200, validateStatus: () => true });
            if (response.status >= 200 && response.status < 300) return;
        } catch (error) {
            lastError = error.code === 'ECONNREFUSED' ? '' : error.message;
            try {
                const r2 = await axios.get(propsUrl, { timeout: 1000, validateStatus: () => true });
                if (r2.status >= 200 && r2.status < 300) return;
            } catch (e2) {}
            try {
                const r3 = await axios.get(rootUrl, { timeout: 1000, validateStatus: () => true });
                if (r3.status >= 200 && r3.status < 300) return;
            } catch (e3) {}
        }
        await new Promise(resolve => setTimeout(resolve, 200));
    }
    const logs = getRecentLogs ? getRecentLogs() : '';
    const errorDetail = logs ? '\n\nLog output:\n' + logs : '';
    throw new Error('Timed out waiting for llama-server to become ready.' + errorDetail);
}

ipcMain.handle('start-server', async (event, params) => {
    let { modelName, port, ctxSize, gpuLayers, extraArgs, temperature, topK, topP, minP, repeatPenalty, maxTokens, maxTokensUnlimited } = params || {};

    if (llamaProcess || serverStarting) {
        throw new Error('Server is already running. Please stop it first.');
    }

    port = parseInt(port, 10);
    if (isNaN(port) || port < 1 || port > 65535) port = 8080;

    ctxSize = parseInt(ctxSize, 10);
    if (isNaN(ctxSize) || ctxSize < 1) ctxSize = 8192;

    gpuLayers = (gpuLayers !== undefined && gpuLayers !== null && !isNaN(parseInt(gpuLayers, 10)))
        ? parseInt(gpuLayers, 10)
        : 99;

    let exePath = findExecutable(getBinDir());
    if (!exePath) {
        exePath = findExecutable(process.cwd());
    }

    if (!exePath) {
        throw new Error('llama-server executable not found. Please install or link llama.cpp via Backend & Updates tab.');
    }

    if (!modelName) {
        throw new Error('No model selected. Please select a model first.');
    }

    let modelPath = path.join(getModelsDir(), modelName);
    try {
        modelPath = fs.realpathSync(modelPath);
    } catch (e) {}

    if (!fs.existsSync(modelPath)) {
        const fallback1 = path.join(app.getPath('userData'), 'models', modelName);
        const fallback2 = path.join(app.getPath('appData'), 'llama-manager', 'models', modelName);
        if (fs.existsSync(fallback1)) {
            modelPath = fallback1;
        } else if (fs.existsSync(fallback2)) {
            modelPath = fallback2;
        } else if (fs.existsSync(modelName)) {
            modelPath = modelName;
        } else {
            throw new Error('Selected model file "' + modelName + '" was not found. Please verify the model file in the Models tab.');
        }
    }

    const args = [
        '-m', modelPath,
        '--host', '127.0.0.1',
        '--port', port.toString(),
        '-c', ctxSize.toString(),
        '-ngl', gpuLayers.toString(),
        '-fa', 'auto'
    ];

    // Check for linked vision projector (mmproj) adapter with auto-detection
    const meta = readModelsMeta();
    let mmprojPath = null;
    if (meta[modelName] && meta[modelName].mmproj) {
        mmprojPath = path.join(getModelsDir(), meta[modelName].mmproj);
        try { mmprojPath = fs.realpathSync(mmprojPath); } catch (e) {}
        if (!fs.existsSync(mmprojPath) && meta[modelName].mmprojFullPath && fs.existsSync(meta[modelName].mmprojFullPath)) {
            mmprojPath = meta[modelName].mmprojFullPath;
        }
    }
    // Auto-detection fallback: if no explicit mmproj linked, search models directory for matching mmproj
    if (!mmprojPath || !fs.existsSync(mmprojPath)) {
        try {
            const modelsDir = getModelsDir();
            const allFiles = fs.readdirSync(modelsDir);
            const pureBase = modelName.replace(/[-_]?(Q[0-9]_[A-Z0-9]+|f16|f32)?.gguf$/i, '').toLowerCase();
            const candidate = allFiles.find(f => {
                const fl = f.toLowerCase();
                return fl.endsWith('.gguf') && (fl.includes('mmproj') || fl.includes('projector')) && fl.includes(pureBase);
            }) || allFiles.find(f => f.toLowerCase().startsWith('mmproj') && f.toLowerCase().endsWith('.gguf'));
            if (candidate) {
                mmprojPath = path.join(modelsDir, candidate);
            }
        } catch (e) {}
    }
    if (mmprojPath && fs.existsSync(mmprojPath)) {
        console.log('Loading vision projector (mmproj):', mmprojPath);
        args.push('--mmproj', mmprojPath);
    }

    const samplingArgs = [
        { flag: '--temp', value: temperature },
        { flag: '--top-k', value: topK },
        { flag: '--top-p', value: topP },
        { flag: '--min-p', value: minP },
        { flag: '--repeat-penalty', value: repeatPenalty }
    ];

    if (maxTokensUnlimited === false || maxTokensUnlimited === undefined) {
        samplingArgs.push({ flag: '--n-predict', value: (maxTokens !== undefined && maxTokens !== null) ? maxTokens : -1 });
    }

    for (const { flag, value } of samplingArgs) {
        if (value !== undefined && value !== null && value !== '' && !isNaN(parseFloat(value))) {
            args.push(flag, parseFloat(value).toString());
        }
    }

    if (extraArgs && extraArgs.trim().length > 0) {
        args.push(...splitCommandLine(extraArgs.trim()));
    }

    const workingDir = path.dirname(exePath);
    console.log('Spawning:', exePath, args.join(' '));

    serverStarting = true;
    let recentLogLines = [];
    const pushLog = (txt) => {
        recentLogLines.push(txt);
        if (recentLogLines.length > 25) recentLogLines.shift();
    };

    const child = spawn(exePath, args, { cwd: workingDir, windowsHide: true });
    llamaProcess = child;

    child.stdout.on('data', (data) => {
        const str = data.toString();
        pushLog(str);
        if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('server-log', str);
        }
    });

    child.stderr.on('data', (data) => {
        const str = data.toString();
        pushLog(str);
        if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('server-log', str);
        }
    });

    child.on('error', (error) => {
        const str = '\n[Unable to start server: ' + error.message + ']\n';
        pushLog(str);
        if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('server-log', str);
        }
    });

    child.on('close', (code) => {
        if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('server-log', '\n[Server exited with code ' + code + ']\n');
            mainWindow.webContents.send('server-stopped');
        }
        llamaProcess = null;
        serverStarting = false;
    });

    try {
        await waitForServer(port, child, () => recentLogLines.join(''));
        serverStarting = false;
        return { url: 'http://127.0.0.1:' + port };
    } catch (error) {
        if (llamaProcess === child) {
            try { child.kill(); } catch (e) {}
            llamaProcess = null;
        }
        serverStarting = false;
        throw error;
    }
});

ipcMain.handle('stop-server', () => {
    if (llamaProcess) {
        llamaProcess.kill();
        llamaProcess = null;
        serverStarting = false;
        return true;
    }
    return false;
});
