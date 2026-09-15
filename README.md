<div align="center">

# Llama.cpp Manager

**Desktop interface for downloading, configuring, and running [llama.cpp](https://github.com/ggml-org/llama.cpp).**

Built with Electron for Windows and Linux.

<img src="screenshots/dashboard.png" alt="Llama.cpp Manager Dashboard" width="860"/>

[![MIT License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
![Platform](https://img.shields.io/badge/platform-Windows%20%7C%20Linux-lightgrey)
[![Latest Release](https://img.shields.io/github/v/release/bunnywaffle/Llama-cpp-manager)](https://github.com/bunnywaffle/Llama-cpp-manager/releases/latest)
[![Electron](https://img.shields.io/badge/Electron-43-blue)](https://www.electronjs.org/)

</div>

---

## Overview

Llama.cpp Manager runs `llama-server` behind a desktop interface. You can download release builds, configure hardware flags, link speculative drafter models, and chat in the app.

- **Backend management**: Download CPU, CUDA, or Vulkan builds from GitHub releases, or link a local build.
- **Hardware controls**: Configure GPU offload (`-ngl`), CPU threads (`-t`), context size (`-c`), flash attention (`-fa`), and RAM lock (`--mlock`).
- **Speculative decoding**: Link companion drafters (DSpark, MTP, DFlash, EAGLE3) with draft token limits (`--spec-draft-n-max`) and drafter GPU layers (`-ngld`).
- **Chat and sampling**: Stream responses, edit prompt branches, and adjust samplers (Min P, Temperature, Top K, Top P, XTC, DRY).
- **LoRA and MCP**: Chain LoRA adapters with weight scaling, and connect stdio MCP tools.
- **Portability**: Runs as a single portable `.exe` or an installer, with portable data storage options.

---

## Screenshots

| Dashboard & Quick Toggles | Chat & Sampling |
|:---:|:---:|
| <img src="screenshots/dashboard.png" alt="Dashboard" width="460"/> | <img src="screenshots/chat.png" alt="Chat" width="460"/> |
| *Server status, CPU threads, context, and hardware controls* | *Streaming chat, branch editing, and live sampling* |

| Models & Drafters | Server Configuration |
|:---:|:---:|
| <img src="screenshots/models.png" alt="Models" width="460"/> | <img src="screenshots/server.png" alt="Server" width="460"/> |
| *GGUF library, companion drafters, and LoRA adapters* | *Hardware parameters, context, and samplers* |

| Backend Manager |
|:---:|
| <img src="screenshots/backends.png" alt="Backend Manager" width="700"/> |
| *Installed builds with version switching* |

---

## Installation

Download the installer or portable executable from the **[Releases](https://github.com/bunnywaffle/Llama-cpp-manager/releases)** page:

1. Download **`Llama.cpp Manager Setup 1.0.8.exe`** or **`Llama.cpp Manager 1.0.8.exe`** from [Latest Release](https://github.com/bunnywaffle/Llama-cpp-manager/releases/latest).
2. Open the application.
3. In **Backends**, install a release build or link your local llama.cpp directory.
4. In **Models**, choose your GGUF directory and start the server.

---

## Development

### Install dependencies

```bash
npm install
```

### Run from source

```bash
npm start
```

### Build packages

```bash
# Setup installer
npm run build

# Portable executable
npm run build-portable
```

---

## License

This project is licensed under the [MIT License](LICENSE).