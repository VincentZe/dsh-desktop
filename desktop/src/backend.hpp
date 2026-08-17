#pragma once

#include <windows.h>

#include <memory>
#include <string>

#include "config.hpp"

namespace dsh_desktop {

/**
 * Spawns `node <cli> [args]` hidden, redirects stdout/stderr to a pipe, and
 * reports backend readiness/exit through window messages posted to the owner
 * HWND. The child is placed in a job object with KILL_ON_JOB_CLOSE, so Stop()
 * or destruction terminates the whole process tree.
 */
class BackendProcess {
 public:
  BackendProcess();
  ~BackendProcess();

  BackendProcess(const BackendProcess&) = delete;
  BackendProcess& operator=(const BackendProcess&) = delete;

  bool Start(HWND owner, const BackendConfig& config, std::wstring& error_message);
  void Stop();

  /** Posted to the owner: lParam is a wcsdup'ed URL the receiver must free. */
  static constexpr UINT kUrlMessage = WM_APP + 0x41;
  /** Posted to the owner when the backend exits: wParam is the exit code. */
  static constexpr UINT kExitMessage = WM_APP + 0x42;

  /** Recently captured backend output (for diagnostics), newest last. */
  std::wstring Diagnostics() const;

 private:
  struct Impl;
  std::unique_ptr<Impl> impl_;
};

}  // namespace dsh_desktop
