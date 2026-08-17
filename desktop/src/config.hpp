#pragma once

#include <windows.h>

#include <filesystem>
#include <string>
#include <vector>

namespace dsh_desktop {

/** Backend process settings: `node <cli> [args]` running in a directory. */
struct BackendConfig {
  std::wstring node = L"node";
  std::wstring cli = L"..\\..\\..\\apps\\cli\\lib\\bin.js";
  std::vector<std::wstring> args = {L"--profile", L"web", L"--port", L"0"};
  std::wstring working_directory = L"..\\..\\..";
};

/** Top-level window settings. */
struct WindowConfig {
  std::wstring title = L"DeepSeek Harness";
  int width = 1280;
  int height = 860;
  int min_width = 800;
  int min_height = 600;
  bool always_on_top = false;
  bool dark_title_bar = true;
};

/** WebView2 settings. */
struct WebViewConfig {
  std::wstring user_data_folder = L"DshDesktop\\WebView2";
  bool enable_devtools = true;
};

/** Full application configuration, overlaid from config.json beside the exe. */
struct AppConfig {
  BackendConfig backend;
  WindowConfig window;
  WebViewConfig webview;
  int start_timeout_seconds = 120;
};

/**
 * Load config.json from exe_dir over the compiled defaults. Missing file is
 * not an error. On a malformed file, returns false and fills error_message.
 */
bool LoadConfig(const std::filesystem::path& exe_dir, AppConfig& out,
                std::wstring& error_message);

/** Resolve relative backend paths against exe_dir; leaves absolute paths alone. */
void ResolveBackendPaths(const std::filesystem::path& exe_dir, BackendConfig& backend);

}  // namespace dsh_desktop
