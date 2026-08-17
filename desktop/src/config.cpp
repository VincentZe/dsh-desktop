#include "config.hpp"

#include <fstream>
#include <iterator>

#include "json.hpp"

namespace dsh_desktop {

namespace {

bool ReadUtf8File(const std::filesystem::path& path, std::wstring& out) {
  std::ifstream stream(path, std::ios::binary);
  if (!stream) return false;
  std::string bytes((std::istreambuf_iterator<char>(stream)),
                    std::istreambuf_iterator<char>());
  if (bytes.empty()) {
    out.clear();
    return true;
  }
  const int length = MultiByteToWideChar(
      CP_UTF8, MB_ERR_INVALID_CHARS, bytes.data(), static_cast<int>(bytes.size()),
      nullptr, 0);
  if (length <= 0) return false;
  out.resize(static_cast<std::size_t>(length));
  MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, bytes.data(),
                      static_cast<int>(bytes.size()), out.data(), length);
  return true;
}

void SetWindowOverrides(const json::Object& root, WindowConfig& window) {
  const json::Value* section = json::Find(root, L"window");
  if (!section || !json::IsObject(*section)) return;
  const auto& obj = *json::AsObject(*section);
  if (const json::Value* v = json::Find(obj, L"title"); v && json::IsString(*v)) {
    window.title = *json::AsString(*v);
  }
  if (const json::Value* v = json::Find(obj, L"width"); v && json::IsNumber(*v)) {
    window.width = static_cast<int>(*json::AsNumber(*v));
  }
  if (const json::Value* v = json::Find(obj, L"height"); v && json::IsNumber(*v)) {
    window.height = static_cast<int>(*json::AsNumber(*v));
  }
  if (const json::Value* v = json::Find(obj, L"minWidth"); v && json::IsNumber(*v)) {
    window.min_width = static_cast<int>(*json::AsNumber(*v));
  }
  if (const json::Value* v = json::Find(obj, L"minHeight"); v && json::IsNumber(*v)) {
    window.min_height = static_cast<int>(*json::AsNumber(*v));
  }
  if (const json::Value* v = json::Find(obj, L"alwaysOnTop"); v && json::IsBool(*v)) {
    window.always_on_top = *json::AsBool(*v);
  }
  if (const json::Value* v = json::Find(obj, L"darkTitleBar"); v && json::IsBool(*v)) {
    window.dark_title_bar = *json::AsBool(*v);
  }
}

void SetWebViewOverrides(const json::Object& root, WebViewConfig& webview) {
  const json::Value* section = json::Find(root, L"webview");
  if (!section || !json::IsObject(*section)) return;
  const auto& obj = *json::AsObject(*section);
  if (const json::Value* v = json::Find(obj, L"userDataFolder"); v && json::IsString(*v)) {
    webview.user_data_folder = *json::AsString(*v);
  }
  if (const json::Value* v = json::Find(obj, L"enableDevtools"); v && json::IsBool(*v)) {
    webview.enable_devtools = *json::AsBool(*v);
  }
}

void SetBackendOverrides(const json::Object& root, BackendConfig& backend) {
  const json::Value* section = json::Find(root, L"backend");
  if (!section || !json::IsObject(*section)) return;
  const auto& obj = *json::AsObject(*section);
  if (const json::Value* v = json::Find(obj, L"node"); v && json::IsString(*v)) {
    backend.node = *json::AsString(*v);
  }
  if (const json::Value* v = json::Find(obj, L"cli"); v && json::IsString(*v)) {
    backend.cli = *json::AsString(*v);
  }
  if (const json::Value* v = json::Find(obj, L"workingDirectory");
      v && json::IsString(*v)) {
    backend.working_directory = *json::AsString(*v);
  }
  if (const json::Value* v = json::Find(obj, L"args"); v && json::IsArray(*v)) {
    backend.args.clear();
    for (const json::Value& item : *json::AsArray(*v)) {
      if (json::IsString(item)) backend.args.push_back(*json::AsString(item));
    }
  }
}

}  // namespace

bool LoadConfig(const std::filesystem::path& exe_dir, AppConfig& out,
                std::wstring& error_message) {
  const std::filesystem::path config_path = exe_dir / L"config.json";
  if (!std::filesystem::exists(config_path)) return true;

  std::wstring text;
  if (!ReadUtf8File(config_path, text)) {
    error_message = L"Unable to read " + config_path.wstring();
    return false;
  }
  std::optional<json::Value> root = json::Parse(text);
  if (!root || !json::IsObject(*root)) {
    error_message = L"config.json is not a valid JSON object";
    return false;
  }
  const json::Object& object = *json::AsObject(*root);
  SetBackendOverrides(object, out.backend);
  SetWindowOverrides(object, out.window);
  SetWebViewOverrides(object, out.webview);
  if (const json::Value* v = json::Find(object, L"startTimeoutSeconds");
      v && json::IsNumber(*v)) {
    out.start_timeout_seconds = static_cast<int>(*json::AsNumber(*v));
  }
  return true;
}

void ResolveBackendPaths(const std::filesystem::path& exe_dir, BackendConfig& backend) {
  const auto resolve = [&exe_dir](std::wstring& value) {
    std::filesystem::path path(value);
    if (path.is_absolute()) return;
    value = (exe_dir / path).lexically_normal().wstring();
  };
  if (!backend.node.empty() && backend.node != L"node") resolve(backend.node);
  if (!backend.cli.empty()) resolve(backend.cli);
  if (!backend.working_directory.empty()) resolve(backend.working_directory);
  else backend.working_directory = exe_dir.wstring();
}

}  // namespace dsh_desktop
