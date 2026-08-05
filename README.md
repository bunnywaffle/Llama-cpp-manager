# Llama.cpp Manager

A simple Windows desktop application for downloading, configuring, and running [llama.cpp](https://github.com/ggml-org/llama.cpp) locally. It provides a graphical interface for managing llama.cpp backends, GGUF models, server settings, and the built-in llama.cpp Web UI.

## Features

- Install llama.cpp from GitHub releases
- Link an existing llama.cpp installation
- Import GGUF models or link a models folder
- Configure the llama-server port, context size, GPU layers, and extra arguments
- Start and stop the llama.cpp server from the dashboard
- View server logs and status information
- Open the running llama.cpp Web UI inside the application
- Light, dark, midnight, and glass themes
- Portable Windows build available from GitHub Releases

## Requirements

- Windows 10 or later
- A llama.cpp build containing `llama-server.exe`
- At least one compatible GGUF model
- Hardware resources appropriate for the selected model

The application can download a compatible llama.cpp release automatically, or you can link an existing installation from the **Backends** section.

## Getting started

1. Download the portable executable from the [Releases](https://github.com/bunnywaffle/Llamacppmanager/releases) page.
2. Launch `Llama.cpp Manager`.
3. Open **Backends** and install llama.cpp or link an existing folder.
4. Open **Models** and add a GGUF model.
5. Select the model and configure the server settings.
6. Start the server from the Dashboard or Server section.
7. Open **Web UI** to use the embedded chat interface.

## Development

### Install dependencies

```bash
npm install
```

### Run from source

```bash
npm start
```

### Build the installer

```bash
npm run build
```

### Build the portable application

```bash
npm run build-portable
```

The generated files are placed in the `dist/` directory. Build output and `node_modules/` are intentionally excluded from the source repository. The portable executable is attached to each GitHub release.

## Project structure

- `main.js` - Electron main process, IPC handlers, llama-server process management, downloads, and file operations
- `index.html` - Application interface and renderer-side logic
- `package.json` - Project metadata, dependencies, and build configuration
- `LICENSE` - MIT license

## License

This project is licensed under the [MIT License](LICENSE).

## Third-party software

This application manages and runs [llama.cpp](https://github.com/ggml-org/llama.cpp). llama.cpp and any downloaded model files are subject to their own licenses and terms. Check the license of each model before using or distributing it.
