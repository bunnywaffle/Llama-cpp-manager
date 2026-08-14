const { app, BrowserWindow, ipcMain, dialog, Menu } = require('electron');
const path = require('path');
const fs = require('fs');
const axios = require('axios');
const AdmZip = require('adm-zip');
const { spawn } = require('child_process');

let mainWindow;
let llamaProcess = null;
let serverStarting = false;

const baseUserDataDir = app.getPath('userData');
const binDir = path.join(baseUserDataDir, 'bin');
const modelsDir = path.join(baseUserDataDir, 'models');
const settingsPath = path.join(baseUserDataDir, 'settings.json');
const personasPath = path.join(baseUserDataDir, 'personas.json');

if (!fs.existsSync(binDir)) fs.mkdirSync(binDir, { recursive: true });
if (!fs.existsSync(modelsDir)) fs.mkdirSync(modelsDir, { recursive: true });

const DEFAULT_SETTINGS = {
    port: 8080,
    ctxSize: 40000,
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
        const raw = fs.readFileSync(settingsPath, 'utf8');
        return { ...DEFAULT_SETTINGS, ...JSON.parse(raw) };
    } catch (e) {
        return { ...DEFAULT_SETTINGS };
    }
}

function saveSettings(settings) {
    const merged = { ...getSettings(), ...(settings || {}) };
    fs.writeFileSync(settingsPath, JSON.stringify(merged, null, 2));
    return merged;
}

const DEFAULT_PERSONAS = [
    { id: 'general', name: 'General Assistant', systemPrompt: 'You are a helpful, accurate, and concise assistant.' },
    { id: 'coder', name: 'Coding Expert', systemPrompt: 'You are an expert software engineer. Provide clean, idiomatic code with short explanations. Use fenced code blocks with language tags.' },
    { id: 'writer', name: 'Creative Writer', systemPrompt: 'You are a creative writer with a vivid, engaging style.' }
];

function readPersonas() {
    try {
        const raw = fs.readFileSync(personasPath, 'utf8');
        const parsed = JSON.parse(raw);
        return Array.isArray(parsed) ? parsed : DEFAULT_PERSONAS;
    } catch (e) {
        return DEFAULT_PERSONAS;
    }
}

function writePersonas(list) {
    fs.writeFileSync(personasPath, JSON.stringify(list, null, 2));
}

const GGUF_TYPES = {
    UINT8: 0, INT8: 1, UINT16: 2, INT16: 3, UINT32: 4, INT32: 5,
    FLOAT32: 6, BOOL: 7, STRING: 8, ARRAY: 9, UINT64: 10, INT64: 11, FLOAT64: 12
};

// Reads the trained context length (llama.context_length) from a GGUF file's
// metadata header. Returns null when the file is not GGUF or the key is absent.
// Runs on async file I/O so it never blocks the main process, and grows its
// work buffer geometrically (amortized linear time) to avoid O(n^2) concat.
async function readGgufContextLength(filePath) {
    const fd = await fs.promises.open(filePath, 'r');
    try {
        const READ_CHUNK = 64 * 1024; // 64 KiB per read
        const MAX_META = 256 * 1024 * 1024; // cap metadata scan at 256 MiB
        let buffer = Buffer.alloc(0);
        let filled = 0;   // bytes currently resident in buffer
        let filePos = 0;  // next file offset to read
        let offset = 0;   // parse cursor within buffer

        // Grow the resident buffer (geometrically) and read from the file
        // until at least `needed` additional bytes are available past `offset`.
        const ensure = async (needed) => {
            while (filled < offset + needed) {
                if (filled >= MAX_META) throw new Error('GGUF metadata too large');
                const target = Math.min(Math.max(READ_CHUNK, buffer.length * 2, offset + needed), MAX_META);
                const grown = Buffer.alloc(target);
                buffer.copy(grown, 0, 0, filled);
                buffer = grown;
                const { bytesRead } = await fd.read(buffer, filled, buffer.length - filled, filePos);
                if (bytesRead === 0) throw new Error('Unexpected end of GGUF file');
                filled += bytesRead;
                filePos += bytesRead;
            }
        };

        const readBytes = (n) => {
            const val = buffer.subarray(offset, offset + n);
            offset += n;
            return val;
        };

        const readString = async () => {
            await ensure(8);
            const len = Number(readBytes(8).readBigUInt64LE(0));
            await ensure(len);
            return readBytes(len).toString('utf8');
        };

        const readValue = async (type) => {
            switch (type) {
                case GGUF_TYPES.UINT8: await ensure(1); return readBytes(1).readUInt8(0);
                case GGUF_TYPES.INT8: await ensure(1); return readBytes(1).readInt8(0);
                case GGUF_TYPES.UINT16: await ensure(2); return readBytes(2).readUInt16LE(0);
                case GGUF_TYPES.INT16: await ensure(2); return readBytes(2).readInt16LE(0);
                case GGUF_TYPES.UINT32: await ensure(4); return readBytes(4).readUInt32LE(0);
                case GGUF_TYPES.INT32: await ensure(4); return readBytes(4).readInt32LE(0);
                case GGUF_TYPES.FLOAT32: await ensure(4); return readBytes(4).readFloatLE(0);
                case GGUF_TYPES.BOOL: await ensure(1); return readBytes(1).readUInt8(0) !== 0;
                case GGUF_TYPES.STRING: return readString();
                case GGUF_TYPES.UINT64: await ensure(8); return Number(readBytes(8).readBigUInt64LE(0));
                case GGUF_TYPES.INT64: await ensure(8); return Number(readBytes(8).readBigInt64LE(0));
                case GGUF_TYPES.FLOAT64: await ensure(8); return readBytes(8).readDoubleLE(0);
                case GGUF_TYPES.ARRAY: {
                    await ensure(12);
                    const elemType = readBytes(4).readUInt32LE(0);
                    const n = Number(readBytes(8).readBigUInt64LE(0));
                    const arr = [];
                    for (let i = 0; i < n; i++) arr.push(await readValue(elemType));
                    return arr;
                }
                default: throw new Error('Unknown GGUF value type: ' + type);
            }
        };

        await ensure(4 + 4 + 8 + 8);
        if (readBytes(4).toString('ascii') !== 'GGUF') return null;
        readBytes(4); // version
        readBytes(8); // tensor count
        const kvCount = Number(readBytes(8).readBigUInt64LE(0));

        for (let i = 0; i < kvCount; i++) {
            const key = await readString();
            await ensure(4);
            const type = readBytes(4).readUInt32LE(0);
            const value = await readValue(type);
            if (key === 'llama.context_length' || key === 'context_length') {
                return Number(value) > 0 ? Number(value) : null;
            }
        }
        return null;
    } finally {
        await fd.close();
    }
}

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
                } else if (entry.name.toLowerCase().endsWith('.gguf')) {
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
        return files.filter(f => f.toLowerCase().endsWith('.gguf'));
    } catch (e) {
        return [];
    }
});

ipcMain.handle('delete-model', (event, modelName) => {
    if (!modelName || path.basename(modelName) !== modelName) {
        throw new Error('Invalid model name.');
    }
    const modelPath = path.join(modelsDir, modelName);
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

ipcMain.handle('get-model-ctx', async (event, modelName) => {
    if (!modelName || path.basename(modelName) !== modelName) return null;
    const modelPath = path.join(modelsDir, modelName);
    if (!fs.existsSync(modelPath)) return null;
    try {
        return await readGgufContextLength(modelPath);
    } catch (e) {
        return null;
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

    // Abort any existing stream before starting a new one.
    if (chatStream) {
        try { chatStream.destroy(); } catch (e) {}
        chatStream = null;
    }

    const url = `http://127.0.0.1:${port}/v1/chat/completions`;

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
        const msg = err.response && err.response.data && err.response.data.error
            ? (err.response.data.error.message || err.response.data.error)
            : err.message;
        if (!event.sender.isDestroyed()) event.sender.send('chat-error', { message: msg || 'Failed to connect to the server.' });
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

function splitCommandLine(value) {
    const args = [];
    const pattern = /(?:[^\s"']+|"[^"]*"|'[^']*')+/g;
    for (const item of value.match(pattern) || []) args.push(item.replace(/^("|')|("|')$/g, ''));
    return args;
}

async function waitForServer(port, child, timeoutMs = 45000) {
    const url = `http://127.0.0.1:${port}/health`;
    const startedAt = Date.now();
    let lastError = '';
    while (Date.now() - startedAt < timeoutMs) {
        if (!child || child.exitCode !== null || child.killed) {
            throw new Error(lastError || 'llama-server exited before it was ready. Check Server Logs for details.');
        }
        try {
            const response = await axios.get(url, { timeout: 1200, validateStatus: () => true });
            if (response.status >= 200 && response.status < 300) return;
        } catch (error) {
            lastError = error.code === 'ECONNREFUSED' ? '' : error.message;
        }
        await new Promise(resolve => setTimeout(resolve, 350));
    }
    throw new Error('Timed out waiting for llama-server to become ready. Check Server Logs for the model-loading error.');
}

ipcMain.handle('start-server', async (event, { modelName, port, ctxSize, gpuLayers, extraArgs, temperature, topK, topP, minP, repeatPenalty, maxTokens, maxTokensUnlimited, reasoningEffort }) => {
    if (llamaProcess || serverStarting) {
        throw new Error('Server is already running. Please stop it first.');
    }

    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Port must be a number between 1 and 65535.');
    if (!Number.isInteger(ctxSize) || ctxSize < 1) throw new Error('Context size must be a positive whole number.');
    if (!Number.isInteger(gpuLayers)) throw new Error('GPU layers must be a whole number.');

    const exePath = findExecutable(binDir);
    let modelPath = path.join(modelsDir, modelName);

    // realpath handles both absolute and relative symlink targets correctly.
    try {
        modelPath = fs.realpathSync(modelPath);
    } catch (e) {}

    if (!exePath) {
        throw new Error('llama-server executable not found. Please install or link llama.cpp via Backend & Updates tab.');
    }
    if (!fs.existsSync(modelPath)) {
        throw new Error('Selected model file not found.');
    }

    const args = [
        '-m', modelPath,
        '--host', '127.0.0.1',
        '--port', port.toString(),
        '-c', ctxSize.toString(),
        '-ngl', gpuLayers.toString()
    ];

    const samplingArgs = [
        { flag: '--temp', value: temperature },
        { flag: '--top-k', value: topK },
        { flag: '--top-p', value: topP },
        { flag: '--min-p', value: minP },
        { flag: '--repeat-penalty', value: repeatPenalty }
    ];

    // n_predict = -1 (unlimited) is llama.cpp's default; only pass it when a limit is set.
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
    const child = spawn(exePath, args, { cwd: workingDir, windowsHide: true });
    llamaProcess = child;

    child.stdout.on('data', (data) => {
        if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('server-log', data.toString());
        }
    });

    child.stderr.on('data', (data) => {
        if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('server-log', data.toString());
        }
    });

    child.on('error', (error) => {
        if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('server-log', `\n[Unable to start server: ${error.message}]\n`);
            mainWindow.webContents.send('server-stopped');
        }
        llamaProcess = null;
        serverStarting = false;
    });

    child.on('close', (code) => {
        if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('server-log', `\n[Server exited with code ${code}]\n`);
            mainWindow.webContents.send('server-stopped');
        }
        llamaProcess = null;
        serverStarting = false;
    });

    try {
        await waitForServer(port, child);
        serverStarting = false;
        return { url: `http://127.0.0.1:${port}` };
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
