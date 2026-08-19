#include <windows.h>

#include <cstdlib>
#include <filesystem>
#include <string>
#include <utility>
#include <vector>

#include "backend.hpp"
#include "config.hpp"
#include "luna_ui.hpp"
#include "luna_ui_window_manager.hpp"

namespace {

using dsh_desktop::BackendProcess;
using luna_ui::LunaUI;
using luna_ui::LunaUIConfig;

struct App {
  dsh_desktop::AppConfig config;
  LunaUI shell;
  BackendProcess backend;
  HWND hwnd = nullptr;
  std::wstring pending_url;
  bool url_received = false;
  bool fatal = false;
};

App* g_app = nullptr;
WNDPROC g_previous_proc = nullptr;
constexpr UINT_PTR kStartupTimerId = 1;

std::wstring EscapeHtml(const std::wstring& text) {
  std::wstring out;
  out.reserve(text.size());
  for (const wchar_t c : text) {
    switch (c) {
      case L'&': out += L"&amp;"; break;
      case L'<': out += L"&lt;"; break;
      case L'>': out += L"&gt;"; break;
      case L'"': out += L"&quot;"; break;
      case L'\n': out += L"<br>"; break;
      default: out += c; break;
    }
  }
  return out;
}

std::wstring LoadingHtml() {
  return L"<!doctype html><html><head><meta charset='utf-8'><style>"
         L"html,body{height:100%;margin:0;background:#0f1115;color:#d7dce4;"
         L"font-family:'Segoe UI',system-ui,sans-serif;display:flex;"
         L"align-items:center;justify-content:center}"
         L".dot{display:inline-block;width:10px;height:10px;margin:0 4px;"
         L"border-radius:50%;background:#4f8cff;animation:blink 1.2s infinite}"
         L".dot:nth-child(2){animation-delay:.2s}.dot:nth-child(3){animation-delay:.4s}"
         L"@keyframes blink{0%,80%,100%{opacity:.25}40%{opacity:1}}"
         L"</style></head><body>"
         L"<div><span class='dot'></span><span class='dot'></span><span class='dot'></span>"
         L"<p style='text-align:center;margin-top:18px;font-size:14px;opacity:.7'>"
         L"Starting DeepSeek Harness</p></div></body></html>";
}

std::wstring ErrorHtml(const std::wstring& title, const std::wstring& detail) {
  return L"<!doctype html><html><head><meta charset='utf-8'><style>"
         L"html,body{height:100%;margin:0;background:#1a1013;color:#f2d7dc;"
         L"font-family:'Segoe UI',system-ui,sans-serif;display:flex;"
         L"align-items:center;justify-content:center;padding:32px;box-sizing:border-box}"
         L".box{max-width:720px}.err{color:#ff6b81;font-size:18px;font-weight:600;"
         L"margin-bottom:10px}pre{white-space:pre-wrap;font-size:13px;line-height:1.5;"
         L"opacity:.85;overflow:auto;max-height:55vh}</style></head><body>"
         L"<div class='box'><div class='err'>" + EscapeHtml(title) +
      L"</div><pre>" + EscapeHtml(detail) + L"</pre></div></body></html>";
}

void ShowFatal(App& app, const std::wstring& title, const std::wstring& detail) {
  app.fatal = true;
  if (app.hwnd) app.shell.NavigateToString(ErrorHtml(title, detail));
  MessageBoxW(app.hwnd ? app.hwnd : nullptr, detail.c_str(), title.c_str(),
              MB_OK | MB_ICONERROR);
}

LRESULT CALLBACK AppWindowProc(HWND hwnd, UINT message, WPARAM wparam,
                               LPARAM lparam) {
  App* app = g_app;
  if (!app || app->hwnd != hwnd) {
    return CallWindowProcW(g_previous_proc, hwnd, message, wparam, lparam);
  }
  switch (message) {
    case BackendProcess::kUrlMessage: {
      wchar_t* url = reinterpret_cast<wchar_t*>(lparam);
      if (url) {
        if (!app->url_received) {
          app->url_received = true;
          KillTimer(hwnd, kStartupTimerId);
          app->pending_url = url;
          app->shell.AddAllowedOrigin(luna_ui::UrlOrigin(url));
          if (app->shell.IsReady() && app->shell.Navigate(url)) {
            app->pending_url.clear();
          }
        }
        free(url);
      }
      return 0;
    }
    case BackendProcess::kExitMessage: {
      const DWORD code = static_cast<DWORD>(wparam);
      if (!app->url_received && !app->fatal) {
        const std::wstring detail =
            L"dsh backend exited with code " + std::to_wstring(code) +
            L".\n\n" + app->backend.Diagnostics();
        ShowFatal(*app, L"DeepSeek Harness backend stopped", detail);
      }
      return 0;
    }
    case WM_TIMER:
      if (wparam == kStartupTimerId && !app->url_received && !app->fatal) {
        KillTimer(hwnd, kStartupTimerId);
        const std::wstring detail =
            L"Timed out waiting for the dsh web server to start (" +
            std::to_wstring(app->config.start_timeout_seconds) + L"s).\n\n" +
            app->backend.Diagnostics();
        ShowFatal(*app, L"DeepSeek Harness start timeout", detail);
        return 0;
      }
      break;
    default:
      break;
  }
  return CallWindowProcW(g_previous_proc, hwnd, message, wparam, lparam);
}

std::filesystem::path ExecutableDirectory() {
  std::vector<wchar_t> buffer(1024);
  for (;;) {
    const DWORD length = GetModuleFileNameW(nullptr, buffer.data(),
                                            static_cast<DWORD>(buffer.size()));
    if (length == 0) return {};
    if (length < buffer.size() - 1) {
      return std::filesystem::path(std::wstring(buffer.data(), length)).parent_path();
    }
    buffer.resize(buffer.size() * 2);
  }
}

}  // namespace

int WINAPI wWinMain(HINSTANCE instance, HINSTANCE, PWSTR, int) {
  SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);

  App app;
  g_app = &app;

  const std::filesystem::path exe_dir = ExecutableDirectory();
  std::wstring load_error;
  if (!dsh_desktop::LoadConfig(exe_dir, app.config, load_error)) {
    MessageBoxW(nullptr, load_error.c_str(), L"DeepSeek Harness",
                MB_OK | MB_ICONERROR);
    return 1;
  }
  dsh_desktop::ResolveBackendPaths(exe_dir, app.config.backend);

  if (!app.config.backend.cli.empty() &&
      !std::filesystem::exists(app.config.backend.cli)) {
    const std::wstring message =
        L"dsh backend script not found:\n" + app.config.backend.cli +
        L"\n\nBuild DSH first (pnpm install && pnpm run build) or point "
        L"backend.cli in config.json at an installed dsh CLI "
        L"(e.g. node_modules\\@deepseek-ai\\dsh\\lib\\bin.js).";
    MessageBoxW(nullptr, message.c_str(), L"DeepSeek Harness",
                MB_OK | MB_ICONERROR);
    return 1;
  }

  LunaUIConfig shell_config;
  shell_config.title = app.config.window.title;
  shell_config.app_id = L"DeepSeekHarness";
  shell_config.width = app.config.window.width;
  shell_config.height = app.config.window.height;
  shell_config.min_width = app.config.window.min_width;
  shell_config.min_height = app.config.window.min_height;
  shell_config.always_on_top = app.config.window.always_on_top;
  shell_config.dark_title_bar = app.config.window.dark_title_bar;
  shell_config.remember_bounds = true;
  shell_config.borderless = true;
  shell_config.resizable = true;
  shell_config.maximizable = true;
  shell_config.resize_border = 8;
  shell_config.native_resize_hit_test = false;
  shell_config.rounded_corners = true;
  shell_config.transparent_background = true;
  shell_config.background_color = RGB(14, 15, 19);
  shell_config.user_data_folder = app.config.webview.user_data_folder;
  shell_config.enable_devtools = app.config.webview.enable_devtools;
  shell_config.initial_html = LoadingHtml();

  luna_ui::LunaUIWindowManager window_manager(app.shell);
  window_manager.Attach();

  luna_ui::LunaUIEvents shell_events;
  shell_events.on_ready = [&app]() {
    if (app.pending_url.empty()) return;
    if (!app.shell.Navigate(app.pending_url)) {
      ShowFatal(app, L"Unable to load dsh web UI",
                L"WebView2 became ready but navigation could not be started.");
      return;
    }
    app.pending_url.clear();
  };
  shell_events.on_error = [&app](HRESULT, const std::wstring& detail) {
    ShowFatal(app, L"Unable to start the WebView2 window", detail);
  };
  if (!app.shell.Start(instance, shell_config, std::move(shell_events))) {
    MessageBoxW(nullptr,
                L"Unable to start the WebView2 window. Check that the WebView2 "
                L"Runtime is installed.",
                L"DeepSeek Harness", MB_OK | MB_ICONERROR);
    return 1;
  }
  app.hwnd = app.shell.hwnd();
  g_previous_proc = reinterpret_cast<WNDPROC>(
      SetWindowLongPtrW(app.hwnd, GWLP_WNDPROC,
                        reinterpret_cast<LONG_PTR>(AppWindowProc)));
  SetTimer(app.hwnd, kStartupTimerId,
           static_cast<UINT>(app.config.start_timeout_seconds) * 1000U, nullptr);

  std::wstring backend_error;
  if (!app.backend.Start(app.hwnd, app.config.backend, backend_error)) {
    ShowFatal(app, L"Unable to start dsh backend", backend_error);
  }

  const int result = app.shell.RunMessageLoop();
  app.backend.Stop();
  g_app = nullptr;
  return result;
}
