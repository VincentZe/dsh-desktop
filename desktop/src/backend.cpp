#include "backend.hpp"

#include <cctype>
#include <cstdlib>
#include <deque>
#include <filesystem>
#include <iterator>

namespace dsh_desktop {

namespace {

std::wstring Utf8ToWide(const std::string& value) {
  if (value.empty()) return {};
  const int length = MultiByteToWideChar(
      CP_UTF8, MB_ERR_INVALID_CHARS, value.data(), static_cast<int>(value.size()),
      nullptr, 0);
  if (length <= 0) {
    return std::wstring(value.begin(), value.end());
  }
  std::wstring result(static_cast<std::size_t>(length), L'\0');
  MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, value.data(),
                      static_cast<int>(value.size()), result.data(), length);
  return result;
}

std::wstring QuoteArg(const std::wstring& argument) {
  if (argument.empty()) return L"\"\"";
  if (argument.find_first_of(L" \t\"") == std::wstring::npos) return argument;
  std::wstring quoted = L"\"";
  for (const wchar_t c : argument) {
    if (c == L'"') quoted += L"\\\"";
    else quoted += c;
  }
  quoted += L"\"";
  return quoted;
}

std::wstring ResolveNode(const std::wstring& configured) {
  if (!configured.empty() && configured != L"node") return configured;
  wchar_t buffer[4096];
  const DWORD length = SearchPathW(nullptr, L"node.exe", nullptr,
                                   static_cast<DWORD>(std::size(buffer)), buffer,
                                   nullptr);
  if (length > 0 && length < std::size(buffer)) return buffer;
  return {};
}

}  // namespace

struct BackendProcess::Impl {
  HWND owner = nullptr;
  HANDLE job = nullptr;
  HANDLE process = nullptr;
  HANDLE reader_thread = nullptr;
  HANDLE read_pipe = nullptr;
  HANDLE write_pipe = nullptr;
  HANDLE stdin_handle = nullptr;
  bool found_url = false;
  mutable CRITICAL_SECTION log_lock;
  std::deque<std::wstring> recent_lines;
  std::size_t max_lines = 60;

  Impl() { InitializeCriticalSection(&log_lock); }
  ~Impl() { DeleteCriticalSection(&log_lock); }

  void AddLog(std::wstring line) {
    EnterCriticalSection(&log_lock);
    recent_lines.push_back(std::move(line));
    while (recent_lines.size() > max_lines) recent_lines.pop_front();
    LeaveCriticalSection(&log_lock);
  }

  std::wstring Diagnostics() const {
    EnterCriticalSection(&log_lock);
    std::wstring joined;
    for (const std::wstring& line : recent_lines) {
      joined += line;
      joined += L'\n';
    }
    LeaveCriticalSection(&log_lock);
    return joined;
  }

  void HandleLine(const std::string& line) {
    AddLog(Utf8ToWide(line));
    if (found_url) return;
    constexpr const char* kMarker = "dsh web: ";
    const std::size_t marker_pos = line.find(kMarker);
    if (marker_pos == std::string::npos) return;
    const std::size_t url_start = line.find("http", marker_pos);
    if (url_start == std::string::npos) return;
    std::size_t url_end = url_start;
    while (url_end < line.size() &&
           !std::isspace(static_cast<unsigned char>(line[url_end]))) {
      ++url_end;
    }
    const std::wstring url = Utf8ToWide(line.substr(url_start, url_end - url_start));
    if (url.empty()) return;
    found_url = true;
    wchar_t* copy = _wcsdup(url.c_str());
    if (copy == nullptr) return;
    if (!PostMessageW(owner, kUrlMessage, 0, reinterpret_cast<LPARAM>(copy))) {
      free(copy);
    }
  }

  void ReaderLoop() {
    std::string buffer(4096, '\0');
    std::string pending;
    for (;;) {
      DWORD read = 0;
      if (!ReadFile(read_pipe, buffer.data(), static_cast<DWORD>(buffer.size()),
                    &read, nullptr) ||
          read == 0) {
        break;
      }
      pending.append(buffer.data(), read);
      std::size_t newline = 0;
      while ((newline = pending.find('\n')) != std::string::npos) {
        std::string line = pending.substr(0, newline);
        if (!line.empty() && line.back() == '\r') line.pop_back();
        pending.erase(0, newline + 1);
        HandleLine(line);
      }
    }
    if (!pending.empty()) HandleLine(pending);

    DWORD exit_code = 0;
    if (process) {
      WaitForSingleObject(process, INFINITE);
      GetExitCodeProcess(process, &exit_code);
    }
    PostMessageW(owner, kExitMessage, static_cast<WPARAM>(exit_code), 0);
  }

  static DWORD WINAPI ReaderThreadProc(LPVOID parameter) {
    auto* self = static_cast<Impl*>(parameter);
    self->ReaderLoop();
    return 0;
  }
};

BackendProcess::BackendProcess() : impl_(std::make_unique<Impl>()) {}

BackendProcess::~BackendProcess() { Stop(); }

bool BackendProcess::Start(HWND owner, const BackendConfig& config,
                           std::wstring& error_message) {
  Stop();
  impl_->owner = owner;

  const std::wstring node = ResolveNode(config.node);
  if (node.empty()) {
    error_message = L"node.exe was not found on PATH. Install Node.js or set "
                    L"backend.node in config.json.";
    return false;
  }
  if (!std::filesystem::exists(node)) {
    error_message = L"Node executable not found: " + node;
    return false;
  }

  impl_->job = CreateJobObjectW(nullptr, nullptr);
  if (!impl_->job) {
    error_message = L"CreateJobObjectW failed (error " +
                    std::to_wstring(GetLastError()) + L")";
    return false;
  }
  JOBOBJECT_EXTENDED_LIMIT_INFORMATION job_info{};
  job_info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
  if (!SetInformationJobObject(impl_->job, JobObjectExtendedLimitInformation,
                               &job_info, sizeof(job_info))) {
    error_message = L"SetInformationJobObject failed (error " +
                    std::to_wstring(GetLastError()) + L")";
    return false;
  }

  SECURITY_ATTRIBUTES security{};
  security.nLength = sizeof(security);
  security.bInheritHandle = TRUE;
  if (!CreatePipe(&impl_->read_pipe, &impl_->write_pipe, &security, 0)) {
    error_message = L"CreatePipe failed (error " + std::to_wstring(GetLastError()) +
                    L")";
    return false;
  }
  SetHandleInformation(impl_->read_pipe, HANDLE_FLAG_INHERIT, 0);
  impl_->stdin_handle =
      CreateFileW(L"NUL", GENERIC_READ, FILE_SHARE_READ | FILE_SHARE_WRITE, nullptr,
                  OPEN_EXISTING, 0, nullptr);

  std::wstring command_line = QuoteArg(node);
  if (!config.cli.empty()) command_line += L" " + QuoteArg(config.cli);
  for (const std::wstring& argument : config.args) {
    command_line += L" " + QuoteArg(argument);
  }

  STARTUPINFOW startup{};
  startup.cb = sizeof(startup);
  startup.dwFlags = STARTF_USESTDHANDLES;
  startup.hStdInput = impl_->stdin_handle ? impl_->stdin_handle
                                          : GetStdHandle(STD_INPUT_HANDLE);
  startup.hStdOutput = impl_->write_pipe;
  startup.hStdError = impl_->write_pipe;

  std::wstring working_directory = config.working_directory;
  if (!working_directory.empty() &&
      !std::filesystem::exists(working_directory)) {
    working_directory.clear();
  }

  PROCESS_INFORMATION process_info{};
  if (!CreateProcessW(node.c_str(), command_line.data(), nullptr, nullptr, TRUE,
                      CREATE_NO_WINDOW | CREATE_SUSPENDED, nullptr,
                      working_directory.empty() ? nullptr : working_directory.c_str(),
                      &startup, &process_info)) {
    error_message = L"CreateProcessW failed (error " +
                    std::to_wstring(GetLastError()) + L"): " + command_line;
    return false;
  }
  impl_->process = process_info.hProcess;
  if (!AssignProcessToJobObject(impl_->job, process_info.hProcess)) {
    // The child would otherwise keep running outside the kill-on-close job.
    TerminateProcess(process_info.hProcess, 1);
    CloseHandle(process_info.hThread);
    error_message = L"AssignProcessToJobObject failed (error " +
                    std::to_wstring(GetLastError()) + L")";
    Stop();
    return false;
  }
  ResumeThread(process_info.hThread);
  CloseHandle(process_info.hThread);

  impl_->reader_thread =
      CreateThread(nullptr, 0, &Impl::ReaderThreadProc, impl_.get(), 0, nullptr);
  if (!impl_->reader_thread) {
    error_message = L"CreateThread failed (error " + std::to_wstring(GetLastError()) +
                    L")";
    return false;
  }
  // The child inherited the write end during CreateProcess. Close the
  // parent's copy so ReaderLoop observes EOF when the child exits.
  CloseHandle(impl_->write_pipe);
  impl_->write_pipe = nullptr;
  return true;
}

void BackendProcess::Stop() {
  if (impl_->job) {
    CloseHandle(impl_->job);
    impl_->job = nullptr;  // KILL_ON_JOB_CLOSE terminates the child tree
  }
  // Close our copies of the child-side pipe handles before waiting on the
  // reader thread: ReadFile only sees EOF once every write-end handle is
  // closed, and the parent still holds one.
  if (impl_->write_pipe) {
    CloseHandle(impl_->write_pipe);
    impl_->write_pipe = nullptr;
  }
  if (impl_->stdin_handle) {
    CloseHandle(impl_->stdin_handle);
    impl_->stdin_handle = nullptr;
  }
  if (impl_->reader_thread) {
    WaitForSingleObject(impl_->reader_thread, 15000);
    CloseHandle(impl_->reader_thread);
    impl_->reader_thread = nullptr;
  }
  if (impl_->process) {
    CloseHandle(impl_->process);
    impl_->process = nullptr;
  }
  if (impl_->read_pipe) {
    CloseHandle(impl_->read_pipe);
    impl_->read_pipe = nullptr;
  }
  impl_->found_url = false;
}

std::wstring BackendProcess::Diagnostics() const { return impl_->Diagnostics(); }

}  // namespace dsh_desktop
