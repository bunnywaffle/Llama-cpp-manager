const { app, BrowserWindow, ipcMain, dialog, Menu, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const axios = require('axios');
const AdmZip = require('adm-zip');
const { spawn, spawnSync } = require('child_process');

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

function getBackendsDir() {
    const dir = path.join(getDataDir(), 'backends');
    if (!fs.existsSync(dir)) try { fs.mkdirSync(dir, { recursive: true }); } catch (e) {}
    return dir;
}

function getActiveBackendPath() {
    try {
        const raw = fs.readFileSync(path.join(getDataDir(), 'active-backend.json'), 'utf8');
        const j = JSON.parse(raw);
        if (j && j.active) return j.active;
    } catch (e) {}
    try {
        const entries = fs.readdirSync(getBackendsDir(), { withFileTypes: true });
        const dirs = entries.filter(d => d.isDirectory()).map(d => d.name);
        if (dirs.length > 0) return dirs.sort()[0];
    } catch (e) {}
    return null;
}

function setActiveBackendPath(name) {
    try { fs.writeFileSync(path.join(getDataDir(), 'active-backend.json'), JSON.stringify({ active: name }, null, 2)); } catch (e) {}
}

let _backendsMigrated = false;
function ensureBackendsMigrated() {
    if (_backendsMigrated) return;
    _backendsMigrated = true;
    try {
        const legacyBin = path.join(getDataDir(), 'bin');
        const backendsDir = getBackendsDir();
        const active = getActiveBackendPath();
        if (active) return;
        if (!fs.existsSync(legacyBin)) return;
        const exe = findExecutable(legacyBin);
        if (!exe) return;
        const defaultName = 'default';
        const defaultDir = path.join(backendsDir, defaultName);
        if (!fs.existsSync(defaultDir)) {
            try { fs.mkdirSync(defaultDir, { recursive: true }); } catch (e) {}
            const entries = fs.readdirSync(legacyBin);
            for (const ent of entries) {
                const src = path.join(legacyBin, ent);
                const dst = path.join(defaultDir, ent);
                try {
                    const st = fs.lstatSync(src);
                    if (st.isDirectory()) {
                        fs.cpSync(src, dst, { recursive: true, force: true });
                    } else {
                        fs.copyFileSync(src, dst);
                    }
                } catch (e) {}
            }
            // keep backend.json metadata
            try {
                const ver = getBackendVersion(exe) || '';
                const build = getBackendBuildNumber(exe);
                fs.writeFileSync(path.join(defaultDir, 'backend.json'), JSON.stringify({ name: defaultName, tag: build ? ('b' + build) : ver, installedAt: new Date().toISOString(), migratedFrom: 'bin' }, null, 2));
            } catch (e) {}
        }
        setActiveBackendPath(defaultName);
    } catch (e) {}
}

function getBinDir() {
    ensureBackendsMigrated();
    const active = getActiveBackendPath();
    if (active) {
        const p = path.join(getBackendsDir(), active);
        if (fs.existsSync(p)) return p;
    }
    // fallback to legacy bin for fresh installs / migration not yet done
    const legacy = path.join(getDataDir(), 'bin');
    if (!fs.existsSync(legacy)) try { fs.mkdirSync(legacy, { recursive: true }); } catch (e) {}
    return legacy;
}

function getAllBackends() {
    ensureBackendsMigrated();
    const backendsDir = getBackendsDir();
    let dirs = [];
    try { dirs = fs.readdirSync(backendsDir, { withFileTypes: true }).filter(d => d.isDirectory()).map(d => d.name); } catch (e) {}
    // also include legacy bin if it has exe and not yet migrated or as fallback
    const legacy = path.join(getDataDir(), 'bin');
    try {
        if (fs.existsSync(legacy) && findExecutable(legacy) && !dirs.includes('legacy-bin')) {
            // treat legacy as virtual backend if no migrated default
            if (!dirs.includes('default')) dirs.push('legacy-bin');
        }
    } catch (e) {}
    const active = getActiveBackendPath();
    return dirs.map(name => {
        const dir = name === 'legacy-bin' ? path.join(getDataDir(), 'bin') : path.join(backendsDir, name);
        const exe = findExecutable(dir);
        let meta = {};
        try { meta = JSON.parse(fs.readFileSync(path.join(dir, 'backend.json'), 'utf8')); } catch (e) {}
        const files = (() => { try { return fs.readdirSync(dir); } catch (e) { return []; } })();
        return {
            name,
            dir,
            exePath: exe,
            exeName: exe ? path.basename(exe) : null,
            version: exe ? getBackendVersion(exe) : null,
            build: exe ? getBackendBuildNumber(exe) : null,
            fileCount: files.length,
            isActive: name === active || (name === 'legacy-bin' && !active),
            meta
        };
    }).sort((a,b) => (b.isActive?1:0)-(a.isActive?1:0) || a.name.localeCompare(b.name));
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
    reasoningEffort: 'medium',
    reasoningCollapsed: true,
    autoStartServerOnGenerate: false,
    routerMode: false,
    parallelEnabled: false,
    parallelSlots: 1
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

// Router mode: llama-server only auto-discovers an mmproj when the model and its
// mmproj*.gguf sit together in a subdirectory of --models-dir. For top-level models
// (which is how the app stores them) it never attaches a projector, so vision models
// fail with "image input is not supported". To fix that, generate a --models-preset
// INI that explicitly assigns each linked mmproj to its model.
function buildRouterPresetFile() {
    const meta = readModelsMeta();
    const sections = [];
    for (const [modelName, info] of Object.entries(meta)) {
        if (!info || !info.mmproj) continue;
        const modelPath = path.join(getModelsDir(), modelName);
        if (!fs.existsSync(modelPath)) continue;
        let mmprojPath = null;
        if (info.mmprojFullPath && fs.existsSync(info.mmprojFullPath)) {
            mmprojPath = info.mmprojFullPath;
        } else {
            const p = path.join(getModelsDir(), info.mmproj);
            if (fs.existsSync(p)) mmprojPath = p;
        }
        if (!mmprojPath) continue;
        const routerName = modelName.replace(/\.gguf$/i, '');
        sections.push('[' + routerName + ']');
        sections.push('mmproj = ' + mmprojPath);
        sections.push('');
    }
    if (sections.length === 0) return null;
    const presetPath = path.join(getDataDir(), 'router-models-preset.ini');
    try {
        fs.writeFileSync(presetPath, sections.join('\n'), 'utf8');
        return presetPath;
    } catch (e) {
        return null;
    }
}

function getMcpConfigPath() { return path.join(getDataDir(), 'mcp.json'); }

function readMcpConfig() {
    try {
        const raw = fs.readFileSync(getMcpConfigPath(), 'utf8');
        const j = JSON.parse(raw);
        if (j && typeof j === 'object' && j.mcpServers && typeof j.mcpServers === 'object') return j;
        if (j && typeof j === 'object' && !j.mcpServers) {
            // allow bare server map for convenience
            return { mcpServers: j };
        }
        return { mcpServers: {} };
    } catch (e) {
        return { mcpServers: {} };
    }
}

function writeMcpConfig(cfg) {
    const out = { mcpServers: (cfg && cfg.mcpServers) ? cfg.mcpServers : {} };
    fs.writeFileSync(getMcpConfigPath(), JSON.stringify(out, null, 2));
}

function hasUsableMcpServers() {
    const cfg = readMcpConfig();
    const servers = cfg.mcpServers || {};
    return Object.values(servers).some(s => s && typeof s.command === 'string' && s.command.trim());
}

const GGUF_TYPES = {
    UINT8: 0, INT8: 1, UINT16: 2, INT16: 3, UINT32: 4, INT32: 5,
    FLOAT32: 6, BOOL: 7, STRING: 8, ARRAY: 9, UINT64: 10, INT64: 11, FLOAT64: 12
};

function readGgufContextLength(filePath) {
    try {
        const info = readGgufInfo(filePath);
        return info ? info.ctxLength : null;
    } catch (e) {
        return null;
    }
}

// Reads GGUF metadata to detect context length and MTP (Multi-Token Prediction)
// capability. MTP is present when the metadata contains a key like
// "<arch>.nextn_predict_layers" with a positive value (set by convert_hf_to_gguf.py
// for Qwen3.5/3.6 family models) or tensor names prefixed with "nextn".
function readGgufInfo(filePath) {
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

        let ctxLength = null;
        let mtp = false;
        for (let i = 0; i < kvCount; i++) {
            const key = readString();
            const type = readBytes(4).readUInt32LE(0);
            const value = readValue(type);
            if ((key === 'llama.context_length' || key === 'context_length') && Number(value) > 0) {
                ctxLength = Number(value);
            }
            if (/nextn_predict_layers|mtp/i.test(key)) {
                if (typeof value === 'number' && value > 0) mtp = true;
            }
        }
        return { ctxLength, mtp };
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
    mainWindow.webContents.on('console-message', (event, level, message, line, sourceId) => {
        console.log(`[RENDERER ${level}] ${message} (${sourceId}:${line})`);
    });
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


// ============ LoRA Adapter IPC Handlers ============
ipcMain.handle('link-lora-dialog', async (event, modelName) => {
    if (!modelName) throw new Error('No model name specified.');
    const result = await dialog.showOpenDialog(mainWindow, {
        title: 'Select LoRA Adapter (.gguf) for ' + modelName,
        properties: ['openFile'],
        filters: [{ name: 'GGUF LoRA Adapter', extensions: ['gguf'] }, { name: 'All Files', extensions: ['*'] }]
    });

    if (!result.canceled && result.filePaths.length > 0) {
        const srcPath = result.filePaths[0];
        const fileName = path.basename(srcPath);
        const destPath = path.join(getModelsDir(), fileName);
        if (srcPath !== destPath && !fs.existsSync(destPath)) {
            try {
                fs.symlinkSync(srcPath, destPath, 'file');
            } catch (e) {
                try { fs.copyFileSync(srcPath, destPath); } catch (err) {}
            }
        }
        const meta = readModelsMeta();
        meta[modelName] = meta[modelName] || {};
        meta[modelName].loras = meta[modelName].loras || [];
        // Avoid duplicate entry
        const existingIdx = meta[modelName].loras.findIndex(l => l.file === fileName);
        if (existingIdx >= 0) {
            meta[modelName].loras[existingIdx].scale = 1.0;
            meta[modelName].loras[existingIdx].enabled = true;
        } else {
            meta[modelName].loras.push({
                file: fileName,
                scale: 1.0,
                enabled: true,
                path: srcPath
            });
        }
        writeModelsMeta(meta);
        return meta;
    }
    return null;
});

ipcMain.handle('update-lora-settings', (event, { modelName, loraFile, scale, enabled }) => {
    if (!modelName || !loraFile) return;
    const meta = readModelsMeta();
    if (meta[modelName] && Array.isArray(meta[modelName].loras)) {
        const item = meta[modelName].loras.find(l => l.file === loraFile);
        if (item) {
            if (scale !== undefined) item.scale = parseFloat(scale);
            if (enabled !== undefined) item.enabled = Boolean(enabled);
            writeModelsMeta(meta);
        }
    }
    return meta;
});

ipcMain.handle('unlink-lora', (event, { modelName, loraFile }) => {
    if (!modelName || !loraFile) return;
    const meta = readModelsMeta();
    if (meta[modelName] && Array.isArray(meta[modelName].loras)) {
        meta[modelName].loras = meta[modelName].loras.filter(l => l.file !== loraFile);
        writeModelsMeta(meta);
    }
    return meta;
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

// ============ MTP (Multi-Token Prediction) Drafter IPC Handlers ============
ipcMain.handle('link-mtp-dialog', async (event, modelName) => {
    if (!modelName) throw new Error('No model name specified.');
    const result = await dialog.showOpenDialog(mainWindow, {
        title: 'Select MTP Drafter Model for ' + modelName,
        properties: ['openFile'],
        filters: [{ name: 'GGUF MTP Drafter', extensions: ['gguf'] }, { name: 'All Files', extensions: ['*'] }]
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
        meta[modelName].mtpDrafter = path.basename(destPath);
        meta[modelName].mtpDrafterFullPath = srcPath;
        writeModelsMeta(meta);
        return meta;
    }
    return null;
});

ipcMain.handle('unlink-mtp-drafter', (event, modelName) => {
    if (!modelName) return;
    const meta = readModelsMeta();
    if (meta[modelName]) {
        delete meta[modelName].mtpDrafter;
        delete meta[modelName].mtpDrafterFullPath;
        writeModelsMeta(meta);
    }
    return meta;
});

// ============ MCP Servers (llama.cpp --mcp-servers-config) ============
ipcMain.handle('get-mcp-config', () => {
    return readMcpConfig();
});

ipcMain.handle('save-mcp-config', (event, cfg) => {
    // cfg is expected to be { mcpServers: { name: { command, args, env, cwd, timeout_ms } } } or raw JSON string
    let obj = cfg;
    if (typeof cfg === 'string') {
        try { obj = JSON.parse(cfg); } catch (e) { throw new Error('Invalid JSON: ' + e.message); }
    }
    if (!obj || typeof obj !== 'object') throw new Error('MCP config must be an object');
    // normalize: allow bare map or wrapped
    let servers = obj.mcpServers || obj;
    if (typeof servers !== 'object' || Array.isArray(servers)) throw new Error('mcpServers must be an object');
    // validate each entry has command
    for (const [name, srv] of Object.entries(servers)) {
        if (!srv || typeof srv !== 'object') throw new Error(`Server "${name}" must be an object`);
        if (!srv.command || typeof srv.command !== 'string' || !srv.command.trim()) {
            throw new Error(`Server "${name}" is missing required "command"`);
        }
        if (srv.args && !Array.isArray(srv.args)) throw new Error(`Server "${name}" args must be an array`);
        if (srv.env && (typeof srv.env !== 'object' || Array.isArray(srv.env))) throw new Error(`Server "${name}" env must be an object`);
    }
    const normalized = { mcpServers: servers };
    writeMcpConfig(normalized);
    return normalized;
});

ipcMain.handle('get-mcp-config-path', () => getMcpConfigPath());

ipcMain.handle('get-mcp-config-raw', () => {
    try { return fs.readFileSync(getMcpConfigPath(), 'utf8'); } catch (e) { return JSON.stringify({ mcpServers: {} }, null, 2); }
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

async function fetchLlamaReleases(perPage = 5) {
    const urls = [
        `https://api.github.com/repos/ggml-org/llama.cpp/releases?per_page=${perPage}`,
        `https://api.github.com/repos/ggerganov/llama.cpp/releases?per_page=${perPage}`
    ];
    let lastErr = null;
    for (const url of urls) {
        try {
            const response = await axios.get(url, { headers: { 'User-Agent': 'LlamaManager-Electron' } });
            return response.data;
        } catch (err) {
            lastErr = err;
        }
    }
    throw lastErr || new Error('Failed to fetch releases from both repos');
}

function selectBackendAsset(release, binDir) {
    const hasCudaDll = fs.existsSync(path.join(binDir, 'ggml-cuda.dll'));
    const cudaMajor = detectCudaVersion(binDir);
    const assets = release.assets || [];
    const lc = (s) => (s || '').toLowerCase();

    // Helper: find asset by predicate that ends with target arch (x64 vs arm64)
    const arch = process.arch === 'arm64' ? 'arm64' : 'x64';
    const findAsset = (pred) => assets.find(a => pred(a) && lc(a.name).endsWith(`-${arch}.zip`));

    // CUDA variant first: match win-cuda-<major> (covers both old cu12.4 and new 12.4 naming)
    if (hasCudaDll && cudaMajor) {
        const cudaAsset = findAsset(a => lc(a.name).startsWith('llama-') && lc(a.name).includes(`win-cuda-${cudaMajor}`))
            || findAsset(a => lc(a.name).startsWith('llama-') && lc(a.name).includes(`cuda-${cudaMajor}`) && lc(a.name).includes('win'))
            || findAsset(a => lc(a.name).startsWith('llama-') && lc(a.name).includes(`cu${cudaMajor}`));
        if (cudaAsset) return cudaAsset;
    }

    // CPU variant: prefer explicit cpu, fallback to generic bin-win without cuda/vulkan/sycl/rocm/openvino
    const cpuAsset = findAsset(a => lc(a.name).startsWith('llama-') && lc(a.name).includes('bin-win-cpu'))
        || findAsset(a => lc(a.name).startsWith('llama-') && lc(a.name).includes('bin-win') && !lc(a.name).includes('cuda') && !lc(a.name).includes('vulkan') && !lc(a.name).includes('sycl') && !lc(a.name).includes('rocm') && !lc(a.name).includes('openvino'))
        || assets.find(a => lc(a.name).startsWith('llama-') && lc(a.name).endsWith(`-${arch}.zip`));
    return cpuAsset || null;
}

function selectCudartAsset(release, cudaMajor) {
    if (!cudaMajor) return null;
    const assets = release.assets || [];
    const lc = (s) => (s || '').toLowerCase();
    const arch = process.arch === 'arm64' ? 'arm64' : 'x64';
    return assets.find(a => lc(a.name).startsWith('cudart-llama-bin-win-cuda-') && lc(a.name).includes(`-cuda-${cudaMajor}`) && lc(a.name).endsWith(`-${arch}.zip`))
        || assets.find(a => lc(a.name).startsWith('cudart-llama-bin-win-cuda-') && lc(a.name).endsWith(`-${arch}.zip`))
        || null;
}

ipcMain.handle('get-releases', async () => {
    try {
        const data = await fetchLlamaReleases(5);
        return data.map(rel => ({
            tag_name: rel.tag_name,
            name: rel.name,
            published_at: rel.published_at,
            assets: rel.assets.map(a => ({ name: a.name, browser_download_url: a.browser_download_url }))
        }));
    } catch (err) {
        throw new Error('Failed to fetch GitHub releases: ' + err.message);
    }
});

ipcMain.handle('check-backend-update', async () => {
    const binDir = getBinDir();
    const exePath = findExecutable(binDir);
    const currentBuild = exePath ? getBackendBuildNumber(exePath) : null;
    const data = await fetchLlamaReleases(10);
    const latest = data.find(r => r.tag_name && r.tag_name.startsWith('b') && !r.draft && !r.prerelease)
        || data.find(r => !r.draft && !r.prerelease);
    if (!latest) throw new Error('No releases found');
    const latestBuild = latest.tag_name.startsWith('b') ? parseInt(latest.tag_name.slice(1), 10) : null;
    const hasUpdate = latestBuild && currentBuild ? (latestBuild > currentBuild) : (!currentBuild);
    return {
        currentBuild,
        latestTag: latest.tag_name,
        latestBuild,
        hasUpdate,
        release: {
            tag_name: latest.tag_name,
            name: latest.name,
            published_at: latest.published_at,
            assets: latest.assets.slice(0, 12).map(a => ({ name: a.name }))
        }
    };
});

ipcMain.handle('update-backend', async (event) => {
    if (llamaProcess) throw new Error('Stop the server before updating the backend.');
    const binDir = getBinDir();
    const data = await fetchLlamaReleases(10);
    const latest = data.find(r => r.tag_name && r.tag_name.startsWith('b') && !r.draft && !r.prerelease)
        || data.find(r => !r.draft && !r.prerelease);
    if (!latest) throw new Error('No suitable release found to update to.');

    const mainAsset = selectBackendAsset(latest, binDir);
    if (!mainAsset) throw new Error('Could not find a backend asset for this system in release ' + latest.tag_name + '.');

    const cudaMajor = detectCudaVersion(binDir);
    const cudartAsset = selectCudartAsset(latest, cudaMajor);

    const archives = [{ asset: mainAsset }];
    if (cudartAsset && cudaMajor) archives.push({ asset: cudartAsset });

    for (const { asset } of archives) {
        const tempZipPath = path.join(getDataDir(), 'temp_update_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6) + '.zip');
        const response = await axios({ url: asset.browser_download_url, method: 'GET', responseType: 'stream' });
        const writer = fs.createWriteStream(tempZipPath);
        response.data.pipe(writer);
        await new Promise((resolve, reject) => {
            writer.on('finish', resolve);
            writer.on('error', reject);
        });
        // Only clean on first archive (main), second is additive
        if (asset === mainAsset) cleanBinDir();
        const zip = new AdmZip(tempZipPath);
        zip.extractAllTo(getBinDir(), true);
        try { fs.unlinkSync(tempZipPath); } catch (e) {}
    }
    return { tag: latest.tag_name, asset: mainAsset.name };
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

// ============ Backend management (view / delete / install / recheck) ============

function listBinFiles() {
    const binDir = getBinDir();
    try {
        if (!fs.existsSync(binDir)) return [];
        return fs.readdirSync(binDir, { withFileTypes: true }).map(e => ({
            name: e.name,
            isDirectory: e.isDirectory(),
            size: e.isDirectory() ? null : (fs.statSync(path.join(binDir, e.name)).size || 0)
        }));
    } catch (e) {
        return [];
    }
}

function getBackendVersion(exePath) {
    if (!exePath || !fs.existsSync(exePath)) return null;
    try {
        const result = spawnSync(exePath, ['--version'], { encoding: 'utf8', timeout: 8000, windowsHide: true });
        const text = (result.stdout || '') + (result.stderr || '');
        const m = text.match(/build:\s*(\d+)/i) || text.match(/version:\s*([^\r\n]+)/i);
        return m ? m[1].trim() : (text.trim() || null);
    } catch (e) {
        return null;
    }
}

function getBackendBuildNumber(exePath) {
    if (!exePath || !fs.existsSync(exePath)) return null;
    try {
        const result = spawnSync(exePath, ['--version'], { encoding: 'utf8', timeout: 8000, windowsHide: true });
        const text = (result.stdout || '') + (result.stderr || '');
        const m = text.match(/build:\s*(\d+)/i) || text.match(/\(build\s+(\d+)/i) || text.match(/build\s+(\d+)/i);
        return m ? parseInt(m[1], 10) : null;
    } catch (e) {
        return null;
    }
}

function detectCudaVersion(binDir) {
    const cudaDll = path.join(binDir, 'ggml-cuda.dll');
    if (!fs.existsSync(cudaDll)) return null;
    try {
        const buf = fs.readFileSync(cudaDll);
        const text = buf.toString('latin1');
        const m = text.match(/cublas64_(\d+)\.\d+\.dll/);
        if (m) return parseInt(m[1], 10);
        const m2 = text.match(/cublas64_(\d+)\.dll/);
        if (m2) return parseInt(m2[1], 10);
        return null;
    } catch (e) {
        return null;
    }
}

function getRequiredCudaRuntimeDlls(cudaMajor) {
    if (!cudaMajor) return [];
    return [
        'cublas64_' + cudaMajor + '.dll',
        'cublasLt64_' + cudaMajor + '.dll',
        'cudart64_' + cudaMajor + '.dll'
    ];
}

ipcMain.handle('get-backend-info', () => {
    const binDir = getBinDir();
    const exePath = findExecutable(binDir);
    const files = listBinFiles();
    return {
        installed: !!exePath,
        exePath: exePath || null,
        exeName: exePath ? path.basename(exePath) : null,
        binDir,
        version: getBackendVersion(exePath || ''),
        files,
        fileCount: files.length,
        dirSize: files.reduce((sum, f) => sum + (f.size || 0), 0)
    };
});

ipcMain.handle('get-backends', () => {
    return getAllBackends();
});

ipcMain.handle('set-active-backend', (event, name) => {
    if (llamaProcess) throw new Error('Stop the server before switching backends.');
    if (!name || typeof name !== 'string') throw new Error('Invalid backend name');
    const backends = getAllBackends().map(b => b.name);
    if (!backends.includes(name)) throw new Error('Backend not found: ' + name);
    setActiveBackendPath(name);
    return getAllBackends();
});

ipcMain.handle('delete-backend-by-name', (event, name) => {
    if (llamaProcess) throw new Error('Stop the server before deleting.');
    if (!name) throw new Error('Invalid name');
    const dir = path.join(getBackendsDir(), name);
    const legacyBin = path.join(getDataDir(), 'bin');
    const target = name === 'legacy-bin' ? legacyBin : dir;
    if (!fs.existsSync(target)) throw new Error('Backend folder not found');
    const active = getActiveBackendPath();
    if (active === name) throw new Error('Cannot delete the active backend — switch to another first.');
    try { fs.rmSync(target, { recursive: true, force: true }); } catch (e) { throw new Error('Failed to delete: ' + e.message); }
    return getAllBackends();
});

ipcMain.handle('install-backend-from-zip-dialog', async (event, customName) => {
    const result = await dialog.showOpenDialog(mainWindow, {
        title: 'Select llama.cpp release zip to install as new backend',
        properties: ['openFile'],
        filters: [{ name: 'Zip archive', extensions: ['zip'] }]
    });
    if (result.canceled || result.filePaths.length === 0) return false;
    const zipPath = result.filePaths[0];
    if (!fs.existsSync(zipPath)) throw new Error('Zip file not found.');
    const zip = new AdmZip(zipPath);
    const entries = zip.getEntries().map(e => e.entryName.replace(/\\/g, '/'));
    const hasExe = entries.some(n => /llama-server\.exe$|server\.exe$|llama-server$|server$/i.test(n));
    if (!hasExe) throw new Error('Selected zip does not appear to contain llama-server/server executable.');
    let name = (customName && typeof customName === 'string' && customName.trim()) ? customName.trim().replace(/[^a-zA-Z0-9._-]/g, '_') : path.basename(zipPath, '.zip').replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 40);
    if (!name) name = 'backend-' + Date.now().toString(36);
    let dir = path.join(getBackendsDir(), name);
    let suffix = 1;
    while (fs.existsSync(dir)) { dir = path.join(getBackendsDir(), name + '-' + suffix); suffix++; name = path.basename(dir); }
    fs.mkdirSync(dir, { recursive: true });
    zip.extractAllTo(dir, true);
    const exe = findExecutable(dir);
    const ver = exe ? (getBackendVersion(exe) || '') : '';
    const build = exe ? getBackendBuildNumber(exe) : null;
    try { fs.writeFileSync(path.join(dir, 'backend.json'), JSON.stringify({ name, tag: build ? ('b' + build) : ver, version: ver, installedAt: new Date().toISOString(), sourceZip: path.basename(zipPath) }, null, 2)); } catch (e) {}
    // auto-switch to new backend if none active
    if (!getActiveBackendPath()) setActiveBackendPath(name);
    return { name, dir, version: ver };
});

ipcMain.handle('install-backend-from-release', async (event, tag, assetName) => {
    if (llamaProcess) throw new Error('Stop the server before installing.');
    const data = await fetchLlamaReleases(30);
    const rel = data.find(r => r.tag_name === tag);
    if (!rel) throw new Error('Release not found: ' + tag);
    let asset = null;
    if (assetName) asset = rel.assets.find(a => a.name === assetName);
    if (!asset) {
        // auto-pick best asset for this system
        asset = selectBackendAsset(rel, getBinDir());
        if (!asset) throw new Error('No suitable asset for this system in ' + tag);
    }
    let name = tag.replace(/^b/, 'b') + '-' + asset.name.replace(/\.zip$/,'').slice(0, 30);
    name = name.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 48);
    let dir = path.join(getBackendsDir(), name);
    let suffix = 1;
    while (fs.existsSync(dir)) { dir = path.join(getBackendsDir(), name + '-' + suffix); suffix++; }
    fs.mkdirSync(dir, { recursive: true });
    const tempZipPath = path.join(getDataDir(), 'temp_backend_' + Date.now() + '.zip');
    const response = await axios({ url: asset.browser_download_url, method: 'GET', responseType: 'stream' });
    const writer = fs.createWriteStream(tempZipPath);
    response.data.pipe(writer);
    await new Promise((resolve, reject) => { writer.on('finish', resolve); writer.on('error', reject); });
    const zip = new AdmZip(tempZipPath);
    zip.extractAllTo(dir, true);
    try { fs.unlinkSync(tempZipPath); } catch (e) {}
    const exe = findExecutable(dir);
    const ver = exe ? (getBackendVersion(exe) || '') : '';
    try { fs.writeFileSync(path.join(dir, 'backend.json'), JSON.stringify({ name: path.basename(dir), tag, asset: asset.name, version: ver, installedAt: new Date().toISOString() }, null, 2)); } catch (e) {}
    return { name: path.basename(dir), dir, version: ver, asset: asset.name };
});

ipcMain.handle('delete-backend', () => {
    if (llamaProcess) {
        throw new Error('Stop the server before deleting the backend.');
    }
    cleanBinDir();
    return true;
});

ipcMain.handle('install-from-zip-dialog', async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
        title: 'Select llama.cpp release zip to install',
        properties: ['openFile'],
        filters: [{ name: 'Zip archive', extensions: ['zip'] }]
    });

    if (result.canceled || result.filePaths.length === 0) return false;

    const zipPath = result.filePaths[0];
    if (!fs.existsSync(zipPath)) throw new Error('Zip file not found.');

    const zip = new AdmZip(zipPath);
    const entries = zip.getEntries().map(e => e.entryName.replace(/\\/g, '/'));
    const hasExe = entries.some(n => /llama-server\.exe$|server\.exe$|llama-server$|server$/i.test(n));
    if (!hasExe) {
        throw new Error('Selected zip does not appear to contain llama-server/server executable. Is this a llama.cpp release zip?');
    }

    cleanBinDir();
    zip.extractAllTo(getBinDir(), true);
    return true;
});

ipcMain.handle('recheck-backend', () => {
    const binDir = getBinDir();
    const exePath = findExecutable(binDir);
    const files = listBinFiles();
    const fileNames = files.filter(f => !f.isDirectory).map(f => f.name.toLowerCase());

    const critical = process.platform === 'win32'
        ? ['llama-server.exe', 'server.exe']
        : ['llama-server', 'server'];
    const commonDlls = process.platform === 'win32'
        ? ['ggml.dll', 'ggml-base.dll', 'ggml-cpu.dll', 'llama.dll', 'ggml-cuda.dll']
        : [];

    const issues = [];
    const warnings = [];
    const missingFiles = [];

    const foundExe = critical.some(c => fileNames.includes(c.toLowerCase()));
    if (exePath && foundExe) {
        const version = getBackendVersion(exePath);
        issues.push({ type: 'ok', text: 'Backend executable found: ' + path.basename(exePath) + (version ? ' (build ' + version + ')' : '') });
    } else {
        issues.push({ type: 'error', text: 'Backend executable not found. Expected one of: ' + critical.join(', ') });
        missingFiles.push({ name: 'llama-server.exe', kind: 'core' });
    }

    if (files.length === 0) {
        issues.push({ type: 'error', text: 'Bin folder is empty. Install a llama.cpp release or link a folder.' });
    }

    for (const dll of commonDlls) {
        if (!fileNames.includes(dll.toLowerCase())) {
            warnings.push({ type: 'warn', text: 'Optional DLL missing: ' + dll });
            if (dll === 'ggml.dll' || dll === 'ggml-base.dll' || dll === 'llama.dll' || dll === 'ggml-cpu.dll') {
                missingFiles.push({ name: dll, kind: 'core' });
            }
        }
    }

    // Detect missing CUDA runtime (the classic "slow after reinstall" cause)
    const hasCudaDll = fileNames.includes('ggml-cuda.dll');
    const cudaMajor = detectCudaVersion(binDir);
    if (hasCudaDll && cudaMajor) {
        const required = getRequiredCudaRuntimeDlls(cudaMajor);
        const missingCuda = required.filter(dll => !fileNames.includes(dll.toLowerCase()));
        if (missingCuda.length > 0) {
            issues.push({
                type: 'error',
                text: 'CUDA runtime DLLs missing (CUDA ' + cudaMajor + '). GPU acceleration will not work — llama-server is falling back to CPU, causing slow generation. Missing: ' + missingCuda.join(', ')
            });
            missingCuda.forEach(dll => missingFiles.push({
                name: dll,
                kind: 'cuda_runtime',
                cudaMajor: cudaMajor
            }));
        }
    }

    const suggestions = [];
    if (issues.some(i => i.type === 'error')) {
        suggestions.push('Use "Install from Zip" to install an official llama.cpp release zip, or "Link Existing Folder" pointing at a folder containing llama-server.');
        if (missingFiles.length > 0) {
            suggestions.push('Or click "Download Missing Files" to fetch the missing CUDA runtime DLLs automatically.');
        }
    }

    return { issues, warnings, suggestions, missingFiles, fileCount: files.length, binDir };
});

ipcMain.handle('download-missing-files', async (event, missingFiles) => {
    const binDir = getBinDir();
    const exePath = findExecutable(binDir);
    const buildNumber = exePath ? getBackendBuildNumber(exePath) : null;
    const cudaMajor = detectCudaVersion(binDir);
    const hasCudaDll = fs.existsSync(path.join(binDir, 'ggml-cuda.dll'));

    // Which kinds were requested? If none given, restore everything missing.
    const kinds = new Set((missingFiles || []).map(f => f.kind || 'core'));
    const requestedNames = (missingFiles || []).map(f => (f.name || '').toLowerCase()).filter(Boolean);
    const wantsRuntime = kinds.has('cuda_runtime') || requestedNames.some(n => n.startsWith('cublas') || n.startsWith('cudart'));

    const releasesData = await fetchLlamaReleases(30);

    let release = null;
    if (buildNumber) {
        release = releasesData.find(r => r.tag_name === ('b' + buildNumber));
    }
    if (!release) {
        release = releasesData.find(r => !r.draft && !r.prerelease && r.tag_name && r.tag_name.startsWith('b'));
    }
    if (!release) {
        release = releasesData.find(r => !r.draft && !r.prerelease);
    }
    if (!release) {
        throw new Error('Could not find a suitable llama.cpp release.');
    }

    const buildTag = release.tag_name;

    // Robust asset selection that handles both old (ggerganov) and new (ggml-org) naming schemes:
    //  - llama-b10629-bin-win-cpu-x64.zip / llama-b10629-bin-win-cuda-12.4-x64.zip
    //  - cudart-llama-bin-win-cuda-12.4-x64.zip etc.
    const mainAsset = selectBackendAsset(release, binDir);
    const cudartAsset = selectCudartAsset(release, cudaMajor);

    if (!mainAsset && !cudartAsset) {
        throw new Error('Could not find any download assets for release ' + buildTag + '.');
    }

    // Only fetch the CUDA runtime archive when the request needs runtime DLLs (avoids a 373MB download otherwise).
    const archives = [{ asset: mainAsset, needed: true }];
    if (cudartAsset && wantsRuntime) {
        archives.push({ asset: cudartAsset, needed: true });
    } else if (cudartAsset && hasCudaDll && cudaMajor && requestedNames.length === 0) {
        archives.push({ asset: cudartAsset, needed: true });
    }

    const extracted = [];
    const missingNow = new Set(
        listBinFiles().filter(f => !f.isDirectory).map(f => f.name.toLowerCase())
    );

    for (const { asset } of archives) {
        if (!asset) continue;
        const tempZipPath = path.join(getDataDir(), 'temp_missing_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6) + '.zip');
        const response = await axios({ url: asset.browser_download_url, method: 'GET', responseType: 'stream' });
        const writer = fs.createWriteStream(tempZipPath);
        response.data.pipe(writer);
        await new Promise((resolve, reject) => {
            writer.on('finish', resolve);
            writer.on('error', (err) => {
                try { fs.unlinkSync(tempZipPath); } catch (e) {}
                reject(err);
            });
        });

        try {
            const zip = new AdmZip(tempZipPath);
            for (const entry of zip.getEntries()) {
                if (entry.isDirectory) continue;
                const name = path.basename(entry.entryName);
                const lower = name.toLowerCase();
                // Only restore files that are currently missing from bin (never overwrite existing).
                if (missingNow.has(lower)) continue;
                const destPath = path.join(binDir, name);
                fs.writeFileSync(destPath, entry.getData());
                missingNow.add(lower);
                extracted.push({ name, source: asset.name });
            }
        } finally {
            try { fs.unlinkSync(tempZipPath); } catch (e) {}
        }
    }

    if (extracted.length === 0) {
        const req = requestedNames.length ? requestedNames.join(', ') : '(no specific files)';
        throw new Error('Nothing to restore from release ' + buildTag + ' — the requested files are either already present or not part of the llama.cpp release assets (' + req + ').');
    }

    return { extracted, release: buildTag };
});

function getExcludedAdapterFiles() {
    try {
        const meta = readModelsMeta();
        const set = new Set();
        for (const info of Object.values(meta)) {
            if (!info) continue;
            if (info.mmproj) set.add(info.mmproj.toLowerCase());
            if (info.mtpDrafter) set.add(info.mtpDrafter.toLowerCase());
            if (Array.isArray(info.loras)) {
                for (const l of info.loras) if (l.file) set.add(l.file.toLowerCase());
            }
        }
        return set;
    } catch (e) { return new Set(); }
}

ipcMain.handle('list-models', () => {
    try {
        const modelsDir = getModelsDir();
        const files = fs.readdirSync(modelsDir);
        const excluded = getExcludedAdapterFiles();
        return files.filter(f => {
            if (!f.toLowerCase().endsWith('.gguf')) return false;
            if (excluded.has(f.toLowerCase())) return false;
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
        const info = readGgufInfo(modelPath) || {};
        const detected = info.ctxLength || 40000;
        meta[modelName] = meta[modelName] || {};
        meta[modelName].ctxLength = detected;
        if (info.mtp) meta[modelName].mtp = true;
        writeModelsMeta(meta);
        return detected;
    } catch (e) {
        return 40000;
    }
});

// Scan every model in the models dir for MTP capability and cache it in models-meta.json.
ipcMain.handle('scan-model-mtp', () => {
    const meta = readModelsMeta();
    let changed = false;
    let files = [];
    try {
        files = fs.readdirSync(getModelsDir()).filter(f => f.toLowerCase().endsWith('.gguf'));
    } catch (e) {}
    for (const file of files) {
        if (meta[file] && meta[file].mtp !== undefined) continue;
        let modelPath = path.join(getModelsDir(), file);
        try {
            modelPath = fs.realpathSync(modelPath);
        } catch (e) {}
        if (!fs.existsSync(modelPath)) continue;
        try {
            const info = readGgufInfo(modelPath);
            if (info && info.mtp) {
                meta[file] = meta[file] || {};
                meta[file].mtp = true;
                changed = true;
            }
        } catch (e) {}
    }
    if (changed) writeModelsMeta(meta);
    return meta;
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
    const { port = 8080, messages, params, model } = payload || {};
    if (!messages || !Array.isArray(messages) || messages.length === 0) {
        event.sender.send('chat-error', { message: 'No messages to send.' });
        return;
    }

    if (chatStream) {
        try { chatStream.destroy(); } catch (e) {}
        chatStream = null;
    }

    const url = 'http://127.0.0.1:' + port + '/v1/chat/completions';

    // Normalize messages: Ensure strictly AT MOST ONE system message at index 0 (satisfies strict Jinja templates)
    let combinedSystemText = '';
    const nonSystemMessages = [];
    for (const m of messages) {
        if (m.role === 'system') {
            const sc = typeof m.content === 'string' ? m.content : (Array.isArray(m.content) ? m.content.map(c => c.text || '').join('\n') : '');
            if (sc && sc.trim()) {
                combinedSystemText = combinedSystemText ? (combinedSystemText + '\n\n' + sc.trim()) : sc.trim();
            }
        } else {
            nonSystemMessages.push(m);
        }
    }

    const finalMessages = [];
    if (combinedSystemText) {
        finalMessages.push({ role: 'system', content: combinedSystemText });
    }
    finalMessages.push(...nonSystemMessages);

    const routerModel = (model && model.trim()) ? model.trim().replace(/\.gguf$/i, '') : '';
    const body = {
        model: routerModel || 'local-model',
        messages: finalMessages,
        stream: true,
        temperature: (params && params.temperature !== undefined) ? params.temperature : 0.8,
        top_p: (params && params.topP !== undefined) ? params.topP : 0.95,
        top_k: (params && params.topK !== undefined) ? params.topK : 40,
        min_p: (params && params.minP !== undefined) ? params.minP : 0.05,
        repeat_penalty: (params && params.repeatPenalty !== undefined) ? params.repeatPenalty : 1.1,
        max_tokens: (params && params.maxTokensUnlimited)
            ? -1
            : ((params && params.maxTokens !== undefined) ? params.maxTokens : 2048),
        reasoning_effort: (params && params.reasoningEffort) ? params.reasoningEffort : undefined,
        // Advanced XTC, DRY, and CFG parameters
        xtc_probability: (params && params.xtcProbability !== undefined) ? parseFloat(params.xtcProbability) : undefined,
        xtc_threshold: (params && params.xtcThreshold !== undefined) ? parseFloat(params.xtcThreshold) : undefined,
        dry_multiplier: (params && params.dryMultiplier !== undefined) ? parseFloat(params.dryMultiplier) : undefined,
        dry_base: (params && params.dryBase !== undefined) ? parseFloat(params.dryBase) : undefined,
        dry_allowed_length: (params && params.dryAllowedLength !== undefined) ? parseInt(params.dryAllowedLength, 10) : undefined,
        dry_penalty_last_n: (params && params.dryPenaltyLastN !== undefined) ? parseInt(params.dryPenaltyLastN, 10) : undefined,
        cfg_scale: (params && params.cfgScale !== undefined && parseFloat(params.cfgScale) > 1.0) ? parseFloat(params.cfgScale) : undefined,
        negative_prompt: (params && params.cfgNegativePrompt) ? params.cfgNegativePrompt : undefined
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
                    const toolCalls = choice.tool_calls || null;
                    if (delta || reasoning || toolCalls) {
                        event.sender.send('chat-chunk', { delta, reasoning, toolCalls });
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
                if (!event.sender.isDestroyed()) event.sender.send('chat-error', { message: parsedMsg || err.message || 'Server error' });
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
    let { modelName, port, ctxSize, gpuLayers, extraArgs, temperature, topK, topP, minP, repeatPenalty, maxTokens, maxTokensUnlimited, routerMode, parallelEnabled, parallelSlots } = params || {};

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

    if (!routerMode && !modelName) {
        throw new Error('No model selected. Please select a model first.');
    }

    let modelPath = null;
    if (!routerMode) {
        modelPath = path.join(getModelsDir(), modelName);
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
    }

    const args = [
        '--host', '127.0.0.1',
        '--port', port.toString(),
        '-c', ctxSize.toString(),
        '-ngl', gpuLayers.toString(),
        '-fa', 'auto'
    ];

    if (routerMode) {
        args.push('--models-dir', getModelsDir());
        const presetPath = buildRouterPresetFile();
        if (presetPath) {
            args.push('--models-preset', presetPath);
        }
    } else {
        args.push('-m', modelPath);
    }

    if (parallelEnabled) {
        const pSlots = parseInt(parallelSlots, 10);
        if (!isNaN(pSlots) && pSlots >= 1) {
            args.push('-np', pSlots.toString());
        }
    }

    // Check for linked vision projector (mmproj) adapter with auto-detection
    // (only in single-model mode; router mode auto-detects mmproj per model)
    const meta = readModelsMeta();
    let mmprojPath = null;
    if (!routerMode && meta[modelName] && meta[modelName].mmproj) {
        mmprojPath = path.join(getModelsDir(), meta[modelName].mmproj);
        try { mmprojPath = fs.realpathSync(mmprojPath); } catch (e) {}
        if (!fs.existsSync(mmprojPath) && meta[modelName].mmprojFullPath && fs.existsSync(meta[modelName].mmprojFullPath)) {
            mmprojPath = meta[modelName].mmprojFullPath;
        }
    }
    // Auto-detection fallback: if no explicit mmproj linked, search models directory for matching mmproj
    if (!routerMode && (!mmprojPath || !fs.existsSync(mmprojPath))) {
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

    // MTP (Multi-Token Prediction) drafter: a separately-linked MTP-head GGUF.
    // Embedded MTP heads (in the main model file) are auto-detected by llama-server,
    // so only a separate drafter needs explicit --spec-draft-model / --spec-type.
    if (!routerMode && meta[modelName] && meta[modelName].mtpDrafter) {
        let mtpDrafterPath = path.join(getModelsDir(), meta[modelName].mtpDrafter);
        try { mtpDrafterPath = fs.realpathSync(mtpDrafterPath); } catch (e) {}
        if (!fs.existsSync(mtpDrafterPath) && meta[modelName].mtpDrafterFullPath && fs.existsSync(meta[modelName].mtpDrafterFullPath)) {
            mtpDrafterPath = meta[modelName].mtpDrafterFullPath;
        }
        if (fs.existsSync(mtpDrafterPath)) {
            console.log('Loading MTP drafter:', mtpDrafterPath);
            args.push('--spec-type', 'draft-mtp');
            args.push('--spec-draft-model', mtpDrafterPath);
        }
    }

    // LoRA Adapters loading — per llama.cpp docs, --lora-scaled accepts comma-separated FNAME:SCALE entries.
    // We join all enabled adapters into a single flag to match the documented format: --lora-scaled a.gguf:1,b.gguf:0.8
    // NOTE: On Windows, absolute paths contain a drive colon (C:\...) which confuses the FNAME:SCALE split
    // (it splits on ':' and expects 2 parts). We work around by passing a relative path from the server's
    // working directory (bin dir) so the only colon is the scale separator.
    if (!routerMode && meta[modelName] && Array.isArray(meta[modelName].loras)) {
        const loraParts = [];
        const binDirForLora = exePath ? path.dirname(exePath) : getBinDir();
        for (const lora of meta[modelName].loras) {
            if (lora.enabled === false) continue;
            let loraPath = path.join(getModelsDir(), lora.file);
            try { loraPath = fs.realpathSync(loraPath); } catch (e) {}
            if (!fs.existsSync(loraPath) && lora.path && fs.existsSync(lora.path)) {
                loraPath = lora.path;
            }
            if (!fs.existsSync(loraPath)) {
                console.warn('LoRA file not found, skipping:', lora.file);
                continue;
            }
            const scale = (lora.scale !== undefined && !isNaN(parseFloat(lora.scale))) ? parseFloat(lora.scale) : 1.0;
            let fnameForArg = loraPath;
            try {
                const rel = path.relative(binDirForLora, loraPath);
                // Use relative if it does not contain a drive colon and is not empty
                if (rel && !rel.includes(':') && rel.length < loraPath.length) {
                    fnameForArg = rel;
                }
            } catch (e) {}
            loraParts.push(`${fnameForArg}:${scale}`);
        }
        if (loraParts.length > 0) {
            console.log('Loading LoRA adapters:', loraParts.join(','));
            args.push('--lora-scaled', loraParts.join(','));
        }
    }

    // MCP servers — minimal, authentic integration: Cursor-compatible JSON, stdio transport per ggml-org/llama.cpp#26062.
    // When the user has at least one server with a command, pass the file via --mcp-servers-config.
    // Note: enabling this limits --cors-origins to localhost by default and spawns child processes with server privileges.
    if (hasUsableMcpServers()) {
        const mcpPath = getMcpConfigPath();
        // ensure file exists and is valid before passing
        try {
            const cfg = readMcpConfig();
            if (cfg.mcpServers && Object.keys(cfg.mcpServers).length > 0) {
                console.log('Using MCP servers config:', mcpPath, '(' + Object.keys(cfg.mcpServers).join(', ') + ')');
                args.push('--mcp-servers-config', mcpPath);
            }
        } catch (e) {
            console.warn('MCP config invalid, skipping:', e.message);
        }
    }

    const { xtcProbability, xtcThreshold, dryMultiplier, dryBase, dryAllowedLength, dryPenaltyLastN, cfgScale, cfgNegativePrompt } = params || {};

    const samplingArgs = [
        { flag: '--temp', value: temperature },
        { flag: '--top-k', value: topK },
        { flag: '--top-p', value: topP },
        { flag: '--min-p', value: minP },
        { flag: '--repeat-penalty', value: repeatPenalty },
        // Advanced XTC
        { flag: '--xtc-probability', value: xtcProbability },
        { flag: '--xtc-threshold', value: xtcThreshold },
        // Advanced DRY
        { flag: '--dry-multiplier', value: dryMultiplier },
        { flag: '--dry-base', value: dryBase },
        { flag: '--dry-allowed-length', value: dryAllowedLength },
        { flag: '--dry-penalty-last-n', value: dryPenaltyLastN },
        // Advanced CFG
        { flag: '--cfg-scale', value: (cfgScale && parseFloat(cfgScale) > 1.0) ? cfgScale : undefined }
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
