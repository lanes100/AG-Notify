# 🔔 AG Notify

> Instantly boost your AI-assisted coding productivity with crystal-clear, cross-platform sound alerts. 

**AG Notify** is a lightweight, 100% free VS Code extension designed to save your focus. It automatically plays beautifully synthesized sound notifications the very second you send a message or when your AI agent (like **Antigravity IDE**) finishes writing code and executing tasks. 

No more staring at progress bars, no more losing focus. Just program, let the agent do the heavy lifting, and react instantly to the satisfying chimes.

---

## ✨ Features

- **🎹 Built-in Sound Alerts:** Includes 10 beautifully designed, high-quality modern `.mp3` chimes that work out-of-the-box on **Windows, macOS, and Linux**:
  - `notification_pluck.mp3` (Default Complete) — A beautiful, soft organic pluck.
  - `smooth_stereo.mp3` — A smooth, wide modern stereo chime.
  - `completed_alert.mp3` — A professional, clear task completion alert.
  - `intro_bell.mp3` — A rich, resonant introduction bell.
  - `best_notification_1.mp3` — A warm, rich notification soundscape.
  - `best_notification_2.mp3` — A clean digital notification soundscape.
  - `message_chime.mp3` (Default Sent) — A warm, elegant double-note chime.
  - `ding.mp3` — A crystal-clear, professional system ding.
  - `notification_alert.mp3` — A clean, satisfying alert notification.
  - `digital_alert.mp3` — A crisp, modern digital interface chime.
- **✉️ Message Sent Sounds:** Plays a customizable chime the moment you send a message in the chat, keeping the conversation flow engaging.
- **🚀 100% Cross-Platform:** Zero configuration needed. The extension automatically resolves sounds natively on Windows, macOS (`afplay`), and Linux (`mpg123`/`aplay`).
- **🎛️ Sleek Status Bar Controls:** Adds an elegant `$(bell) AG Notify` indicator to your status bar. Click it to open an interactive quick-pick control panel to:
  - Configure sounds separately for Completion and Sent messages.
  - Instantly test-play your sound alerts.
  - Quick-mute/unmute all alerts.
- **🛡️ Customization:** Support for absolute custom paths to your own `.wav` or `.mp3` files.
- **⚡ Multi-Window Coordination:** Automatically coordinates across multiple open VS Code windows so notifications only play exactly once.

---

## 🛠️ Quick Start & Installation

1. **Install:** Search for **`AG Notify`** in the Antigravity IDE / VS Code Extensions marketplace and click **Install**.
2. **Done!** The extension is pre-configured with `notification_pluck.mp3` for task completions and `message_chime.mp3` for sent messages.

*To change any sound chime, simply click `$(bell) AG Notify` in the bottom-right status bar or open the Settings Dashboard.*

---

## ⚙️ Extension Settings

Fine-tune your audio feedback directly in VS Code settings:

* `agNotify.enabled`: Global toggle to enable/disable sound notifications (default: `true`).
* `agNotify.soundOnComplete`: Toggle notifications specifically for task completions (default: `true`).
* `agNotify.soundOnCompleteType`: Choose the built-in chime file name or specify a full absolute path to your own WAV/MP3 file for completions (default: `"notification_pluck.mp3"`).
* `agNotify.soundOnSend`: Toggle notifications specifically for sent messages (default: `true`).
* `agNotify.soundOnSendType`: Choose the built-in chime file name or specify a full absolute path to your own WAV/MP3 file for sent messages (default: `"message_chime.mp3"`).

---

## 📄 License

Developed by [lanes100](https://github.com/lanes100). Distributed under the MIT License. See [LICENSE](LICENSE) for more details.
